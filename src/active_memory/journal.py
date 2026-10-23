import hashlib
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

from . import events as ev


class Conflict(Exception):
    pass


class Journal:
    """SQLite holds raw evidence, a durable queue and audit, never semantic/vector memory."""

    def __init__(self, directory: Path, scope: str):
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "journal.sqlite3"
        self.scope = scope
        with self.db() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS episodes(
                  id TEXT PRIMARY KEY, payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
                  deleted INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS jobs(
                  episode_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
                  attempts INTEGER NOT NULL DEFAULT 0, available REAL NOT NULL DEFAULT 0,
                  lease REAL NOT NULL DEFAULT 0, error TEXT);
                CREATE TABLE IF NOT EXISTS audit(
                  id INTEGER PRIMARY KEY, time REAL NOT NULL, actor TEXT NOT NULL,
                  action TEXT NOT NULL, target TEXT NOT NULL);
            """)
            self._migrate_events(db)
            row = db.execute("SELECT value FROM metadata WHERE key='scope'").fetchone()
            if row and row[0] != scope:
                raise ValueError("data directory belongs to a different memory scope")
            db.execute("INSERT OR IGNORE INTO metadata VALUES('scope',?)", (scope,))

    @staticmethod
    def _migrate_events(db):
        """Add the structured-event columns to the existing audit table; old rows stay untouched."""
        columns = {r[1] for r in db.execute("PRAGMA table_info(audit)")}
        for name in ("event", "event_id", "subject"):
            if name not in columns:
                db.execute(f"ALTER TABLE audit ADD COLUMN {name} TEXT")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS recommendations(
              subject TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, recommendation TEXT NOT NULL,
              confidence REAL NOT NULL, reason TEXT NOT NULL, model TEXT NOT NULL, provider TEXT,
              recorded REAL NOT NULL, sequence INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS event_intents(
              id INTEGER PRIMARY KEY, time REAL NOT NULL, body TEXT NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS audit_event_id ON audit(event_id);
            CREATE INDEX IF NOT EXISTS audit_subject ON audit(subject, id);
            CREATE TRIGGER IF NOT EXISTS audit_append_only_update BEFORE UPDATE ON audit
              BEGIN SELECT RAISE(ABORT, 'audit/events are append-only'); END;
            CREATE TRIGGER IF NOT EXISTS audit_append_only_delete BEFORE DELETE ON audit
              BEGIN SELECT RAISE(ABORT, 'audit/events are append-only'); END;
        """)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def ingest(self, message, actor):
        payload = message.model_dump(mode="json")
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
        identity = json.dumps(
            [
                self.scope,
                payload["source_system"],
                payload["conversation_id"],
                payload["message_id"],
            ]
        )
        episode_id = str(uuid5(NAMESPACE_URL, identity))
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM episodes WHERE id=?", (episode_id,)).fetchone()
            if row:
                if row["deleted"]:
                    raise Conflict("source was deleted; use a new source message_id to reimport")
                if row["fingerprint"] != fingerprint:
                    raise Conflict("same source message_id has different payload")
                return episode_id, True
            db.execute(
                "INSERT INTO episodes(id,payload,fingerprint) VALUES(?,?,?)",
                (episode_id, encoded, fingerprint),
            )
            db.execute("INSERT INTO jobs(episode_id) VALUES(?)", (episode_id,))
            self.audit(actor, "ingest", episode_id, db)
        return episode_id, False

    def get(self, episode_id):
        with self.db() as db:
            row = db.execute(
                "SELECT * FROM episodes WHERE id=? AND deleted=0", (episode_id,)
            ).fetchone()
        return json.loads(row["payload"]) if row else None

    def claim(self):
        now = time.time()
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                """SELECT * FROM jobs WHERE
              (status='pending' AND available<=?) OR (status='running' AND lease<?)
              ORDER BY available, rowid LIMIT 1""",
                (now, now),
            ).fetchone()
            if not row:
                return None
            db.execute(
                "UPDATE jobs SET status='running', attempts=attempts+1, lease=? WHERE episode_id=?",
                (now + 1800, row["episode_id"]),
            )
        return row["episode_id"]

    def finish(self, episode_id, error=None, events=()):
        """Mark the job; ``events`` are written in the same SQLite transaction as a successful finish."""
        with self.db() as db:
            for body in events if error is None else ():
                self.append_event(body, db)
            row = db.execute(
                "SELECT attempts FROM jobs WHERE episode_id=?", (episode_id,)
            ).fetchone()
            attempts = row[0]
            status = "done" if error is None else "failed" if attempts >= 3 else "pending"
            db.execute(
                "UPDATE jobs SET status=?,error=?,available=?,lease=0 WHERE episode_id=?",
                (status, error, time.time() + 2**attempts, episode_id),
            )

    def jobs(self):
        with self.db() as db:
            return [dict(r) for r in db.execute("SELECT * FROM jobs ORDER BY rowid DESC LIMIT 100")]

    def live_episodes(self):
        with self.db() as db:
            return [
                (r["id"], json.loads(r["payload"]))
                for r in db.execute("SELECT * FROM episodes WHERE deleted=0 ORDER BY rowid")
            ]

    def retry(self, episode_id, actor):
        with self.db() as db:
            count = db.execute(
                "UPDATE jobs SET status='pending',attempts=0,available=0,error=NULL "
                "WHERE episode_id=? AND status='failed'",
                (episode_id,),
            ).rowcount
            if count:
                self.audit(actor, "retry", episode_id, db)
        return bool(count)

    def requeue(self, episode_ids, actor):
        """Put finished or failed jobs back in the queue so the sources are processed again."""
        count = 0
        with self.db() as db:
            for episode_id in episode_ids:
                changed = db.execute(
                    "UPDATE jobs SET status='pending',attempts=0,available=0,error=NULL "
                    "WHERE episode_id=? AND status IN ('done','failed')",
                    (episode_id,),
                ).rowcount
                if changed:
                    self.audit(actor, "reprocess", episode_id, db)
                count += changed
        return count

    def erase(self, episode_id, actor, event=None, purge=()):
        with self.db() as db:
            db.execute("PRAGMA secure_delete=ON")
            for subject in purge:  # model reasons paraphrase sources: they go with the source
                db.execute("DELETE FROM recommendations WHERE subject=?", (subject,))
            db.execute("UPDATE episodes SET deleted=1,payload='{}' WHERE id=?", (episode_id,))
            db.execute("DELETE FROM jobs WHERE episode_id=?", (episode_id,))
            self.audit(actor, "erase", episode_id, db, event=event)
        # Online copies/backups must be handled by the runbook; this is logical live deletion.

    def audit(self, actor, action, target, db=None, event=None):
        """Append one audit row; with ``event`` it is also a public event. Returns its sequence."""
        if db is None:
            with self.db() as connection:
                return self.audit(actor, action, target, connection, event)
        document = event_id = subject = None
        if event is not None:
            event_id = "ev_" + uuid4().hex
            subject = f"{event['subject']['kind']}:{event['subject']['identifier']}"
            document = json.dumps(event, ensure_ascii=False, sort_keys=True)
        cursor = db.execute(
            "INSERT INTO audit(time,actor,action,target,event,event_id,subject) "
            "VALUES(?,?,?,?,?,?,?)",
            (round(time.time(), 6), actor, action, target, document, event_id, subject),
        )
        return cursor.lastrowid

    def append_event(self, event, db=None):
        """Record a public event (and its operational audit row) after the operation completed."""
        return self.audit(
            event["actor"]["identifier"], event["type"], event["subject"]["identifier"], db, event
        )

    # -- model recommendations: advice stored beside the log, never part of it ------------
    def save_recommendation(self, subject, fingerprint, answer, event):
        """Upsert the current advice and append its (reason-free) event in one transaction."""
        with self.db() as db:
            sequence = self.append_event(event, db)
            data = event["data"]
            db.execute(
                "INSERT OR REPLACE INTO recommendations(subject,fingerprint,recommendation,"
                "confidence,reason,model,provider,recorded,sequence) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    subject,
                    fingerprint,
                    answer.recommendation,
                    answer.confidence,
                    answer.reason,
                    data["model"],
                    data["provider"],
                    round(time.time(), 6),
                    sequence,
                ),
            )
            return sequence

    def recommendations(self):
        with self.db() as db:
            return {r["subject"]: dict(r) for r in db.execute("SELECT * FROM recommendations")}

    # -- intents: bridge between a graph commit and its event ------------------------------
    # An intent is private operational state (not an event, never served): the decision about to
    # be applied to the graph. It lets a crash between the graph commit and the event write be
    # repaired with the true transition instead of an "unknown transition" snapshot.
    def intend(self, event):
        with self.db() as db:
            cursor = db.execute(
                "INSERT INTO event_intents(time,body) VALUES(?,?)",
                (round(time.time(), 6), json.dumps(event, ensure_ascii=False, sort_keys=True)),
            )
            return cursor.lastrowid

    def abandon(self, intent):
        with self.db() as db:
            db.execute("DELETE FROM event_intents WHERE id=?", (intent,))

    def complete(self, event, intent):
        """Append the event and retire its intent in one transaction."""
        with self.db() as db:
            sequence = self.append_event(event, db)
            db.execute("DELETE FROM event_intents WHERE id=?", (intent,))
            return sequence

    def intents(self):
        with self.db() as db:
            return [
                (r["id"], json.loads(r["body"]))
                for r in db.execute("SELECT id, body FROM event_intents ORDER BY id")
            ]

    # -- reading events -------------------------------------------------------------------
    def _public(self, row, deleted):
        body = json.loads(row["event"])
        provenance = [
            {**ref, **({"deleted": ref["id"] in deleted} if ref["kind"] == "source" else {})}
            for ref in body["provenance"]
        ]
        return {
            "schema_version": ev.SCHEMA_VERSION,
            "event_id": row["event_id"],
            "sequence": row["id"],
            "producer": ev.PRODUCER,
            "type": body["type"],
            "occurred_at": body["occurred_at"],
            "recorded_at": ev.iso(row["time"]),
            "actor": body["actor"],
            "subject": body["subject"],
            "previous_state": body["previous_state"],
            "new_state": body["new_state"],
            "provenance": provenance,
            "correlation_id": body["correlation_id"],
            "data": body["data"],
        }

    @staticmethod
    def _deleted_among(db, rows):
        ids = {
            ref["id"]
            for row in rows
            for ref in json.loads(row["event"])["provenance"]
            if ref["kind"] == "source"
        }
        if not ids:
            return set()
        marks = ",".join("?" * len(ids))
        live = {
            r[0]
            for r in db.execute(
                f"SELECT id FROM episodes WHERE deleted=0 AND id IN ({marks})", tuple(ids)
            )
        }
        return ids - live

    def events(
        self, types=(), since=None, until=None, subject=None, cursor=None, limit=50, order="asc"
    ):
        """Page of public events; ``since``/``until`` are epoch seconds on recorded time [since, until)."""
        where, args = ["event IS NOT NULL"], []
        if types:
            where.append(f"json_extract(event,'$.type') IN ({','.join('?' * len(types))})")
            args += list(types)
        if since is not None:
            where.append("time>=?")
            args.append(since)
        if until is not None:
            where.append("time<?")
            args.append(until)
        if subject:
            where.append("subject=?")
            args.append(subject)
        if cursor is not None:
            where.append("id>?" if order == "asc" else "id<?")
            args.append(cursor)
        sql = (
            f"SELECT * FROM audit WHERE {' AND '.join(where)} "
            f"ORDER BY id {'ASC' if order == 'asc' else 'DESC'} LIMIT ?"
        )
        with self.db() as db:
            rows = db.execute(sql, (*args, limit + 1)).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            deleted = self._deleted_among(db, rows)
            page = [self._public(r, deleted) for r in rows]
        return page, more

    def subject_events(self, subject):
        with self.db() as db:
            rows = db.execute(
                "SELECT * FROM audit WHERE subject=? AND event IS NOT NULL ORDER BY id", (subject,)
            ).fetchall()
            deleted = self._deleted_among(db, rows)
            return [self._public(r, deleted) for r in rows]

    def first_sequences(self):
        with self.db() as db:
            return {
                r[0]: r[1]
                for r in db.execute(
                    "SELECT subject, MIN(id) FROM audit WHERE event IS NOT NULL GROUP BY subject"
                )
            }

    def last_state(self, subject):
        """(new_state, sequence) of the newest event that set a state for the subject, else None."""
        with self.db() as db:
            row = db.execute(
                "SELECT id, json_extract(event,'$.new_state') AS state FROM audit "
                "WHERE subject=? AND event IS NOT NULL AND "
                "json_extract(event,'$.new_state') IS NOT NULL ORDER BY id DESC LIMIT 1",
                (subject,),
            ).fetchone()
        return (row["state"], row["id"]) if row else None

    def has_contribution(self, subject, episode_id):
        """True when a created/evidence_added event already cites this source for the subject."""
        with self.db() as db:
            rows = db.execute(
                "SELECT event FROM audit WHERE subject=? AND event IS NOT NULL AND "
                "json_extract(event,'$.type') IN ('candidate.created','candidate.evidence_added','candidate.snapshot')",
                (subject,),
            ).fetchall()
        return any(
            ref["id"] == episode_id and ref["kind"] == "source"
            for row in rows
            for ref in json.loads(row[0])["provenance"]
        )

    def ingest_times(self):
        """episode id -> when the source was first accepted (epoch seconds, from the audit log)."""
        with self.db() as db:
            rows = db.execute(
                "SELECT target, MIN(time) FROM audit WHERE action='ingest' GROUP BY target"
            ).fetchall()
        return {target: stamp for target, stamp in rows}

    def ingest_client(self, episode_id):
        with self.db() as db:
            row = db.execute(
                "SELECT actor FROM audit WHERE action='ingest' AND target=? ORDER BY id LIMIT 1",
                (episode_id,),
            ).fetchone()
        return row[0] if row else None
