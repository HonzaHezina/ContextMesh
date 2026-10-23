import asyncio
import copy
import hashlib
import json
import logging
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4

import httpx

from . import events as ev
from .engine import add_extraction, consolidate, identity, remove_episode
from .graph import Neo4jGraph, ReferenceGraph
from .journal import Conflict, Journal
from .models import Extraction, Message, utcnow
from .providers import (
    GraphitiAdapter,
    LLMExtractor,
    LLMRecommender,
    LLMRelationJudge,
    OpenAIEmbeddings,
)
from .settings import (
    PRESETS,
    RUNTIME_FIELDS,
    SECRET_FIELDS,
    Settings,
    check_endpoint,
    load_overrides,
    save_overrides,
)
from .similarity import (
    candidate_pairs,
    embedding_text,
    pair_id,
    propose,
    recent_evidence,
    text_hash,
    unit,
    usable_vector,
)


class AuditGap(Exception):
    """The operation itself finished, but its event could not be recorded."""

    def __init__(self, applied):
        super().__init__("audit event not recorded")
        self.applied = applied


def principal(client_id):
    # A bearer token authenticates a client. It does not prove a person pressed the button.
    return {"kind": "human", "identifier": client_id, "assurance": "bearer_token"}


SYSTEM = {"kind": "system", "identifier": ev.SYSTEM_ACTOR, "assurance": "internal"}


def sources_of(record):
    seen = []
    for item in record["evidence"]:
        if item["episode_id"] not in seen:
            seen.append(item["episode_id"])
    return [{"kind": "source", "id": i} for i in seen]


def parse_cursor(cursor):
    try:
        sequence, kind, record_id = cursor.split(":", 2)
        return (int(sequence), kind, record_id)
    except ValueError:
        raise ValueError("invalid cursor") from None


class MemoryService:
    def __init__(self, settings):
        self.http_transport = None  # tests inject a mock transport for provider calls
        self.overridden = []
        try:
            overrides = load_overrides(settings.data_dir)
            if overrides:
                settings = Settings(**{**settings.model_dump(), **overrides})
                self.overridden = sorted(overrides)
        except Exception as error:  # fail safe: ignore a broken override file, keep env settings
            logging.getLogger(__name__).warning(
                "ignoring settings override: %s", type(error).__name__
            )
        self.settings = settings
        self.journal = Journal(settings.data_dir, settings.scope)
        self.graph = (
            Neo4jGraph(settings)
            if settings.backend == "neo4j"
            else ReferenceGraph(settings.data_dir, settings.scope)
        )
        self.state = self.graph.load()
        self.lock = asyncio.Lock()
        self.extractor = LLMExtractor(settings) if settings.extraction_mode == "llm" else None
        self.graphiti = GraphitiAdapter(settings) if settings.graphiti_enabled else None
        self.embedder = (
            OpenAIEmbeddings(settings) if settings.similarity_mode == "embedding" else None
        )
        self.judge = LLMRelationJudge(settings) if settings.judge_enabled else None
        self.recommender = LLMRecommender(settings) if settings.recommend_enabled else None
        self.recommend_state = {
            "running": False,
            "done": 0,
            "total": 0,
            "failed": 0,
            "report": None,
        }
        self._recommend_task = None

    async def initialize(self):
        if self.graphiti:
            await self.graphiti.initialize()
        self.recover()
        self.reconcile_events()

    # -- runtime LLM settings --------------------------------------------------------------
    def settings_view(self):
        s = self.settings
        return {
            "runtime": {k: getattr(s, k) for k in RUNTIME_FIELDS if k not in SECRET_FIELDS},
            "secrets": {k: bool(getattr(s, k)) for k in SECRET_FIELDS},
            "overridden": self.overridden,
            "providers": {
                "model_host": urlparse(s.model_base_url).hostname,
                "embedding_host": urlparse(s.effective_embedding_base_url).hostname,
            },
            # What is really used when a field is left empty ("same as model").
            "effective": {
                "advice_model": s.effective_advice_model,
                "embedding_model": s.effective_embedding_model,
                "embedding_dim": s.effective_embedding_dim,
                "embedding_same_provider": not s.embedding_base_url,
                "embedding_same_key": not s.embedding_api_key,
            },
            "presets": PRESETS,
            "fixed": {
                "backend": s.backend,
                "graphiti_enabled": s.graphiti_enabled,
                "scope": s.scope,
            },
            "active": {
                "extraction": "llm" if self.extractor else "provided",
                "embeddings": bool(self.embedder),
                "judge": bool(self.judge),
                "recommendations": bool(self.recommender),
            },
            "usage": {
                "extractor": getattr(self.extractor, "usage", None),
                "embedder": getattr(self.embedder, "usage", None),
                "judge": getattr(self.judge, "usage", None),
                "recommender": getattr(self.recommender, "usage", None),
            },
        }

    async def configure(self, changes, actor):
        """Apply an admin's change to the provider settings; invalid changes change nothing."""
        async with self.lock:
            merged = self.settings.model_dump()
            changed = []
            for key, value in changes.items():
                if key not in RUNTIME_FIELDS or value is None:
                    continue
                if merged[key] != value:
                    changed.append(key)
                    merged[key] = value
            for key in ("model_base_url", "embedding_base_url"):
                if key in changed and merged[key]:
                    check_endpoint(merged[key])
            try:
                new = Settings(**merged)
            except Exception as error:
                errors = getattr(error, "errors", None)
                message = errors()[0]["msg"].removeprefix("Value error, ") if errors else str(error)
                raise ValueError(message) from None
            if not changed:
                return self.settings_view()
            extractor = LLMExtractor(new) if new.extraction_mode == "llm" else None
            embedder = OpenAIEmbeddings(new) if new.similarity_mode == "embedding" else None
            judge = LLMRelationJudge(new) if new.judge_enabled else None
            recommender = LLMRecommender(new) if new.recommend_enabled else None
            save_overrides(new.data_dir, {k: merged[k] for k in RUNTIME_FIELDS})
            self.settings, self.extractor, self.embedder, self.judge = (
                new,
                extractor,
                embedder,
                judge,
            )
            self.recommender = recommender
            self.overridden = sorted(RUNTIME_FIELDS)
            # Names only: no values, no keys. This is operational audit, not a public event.
            self.journal.audit(actor, "settings_changed", ",".join(sorted(changed)))
            return self.settings_view()

    async def test_provider(self, target, actor):
        """One tiny synthetic request (never user data) to check that a provider answers."""
        s = self.settings
        if not s.allow_model_calls:
            raise ValueError("model calls are not allowed; enable them first")
        if target == "model":
            url, key, body = (
                s.model_base_url.rstrip("/") + "/chat/completions",
                s.model_api_key,
                {
                    "model": s.model_name,
                    "messages": [{"role": "user", "content": "Reply with the single word OK."}],
                    "max_tokens": 8,
                },
            )
        else:
            url, key, body = (
                s.effective_embedding_base_url.rstrip("/") + "/embeddings",
                s.effective_embedding_api_key,
                {"model": s.effective_embedding_model, "input": ["test"]},
            )
        if not key:
            raise ValueError("no API key is set for this provider")
        started = time.monotonic()
        result = {"ok": False, "target": target, "host": urlparse(url).hostname}
        try:
            async with httpx.AsyncClient(
                timeout=min(s.timeout_seconds, 30), transport=self.http_transport
            ) as client:
                response = await client.post(
                    url, headers={"Authorization": f"Bearer {key}"}, json=body
                )
            result["status"] = response.status_code
            result["ok"] = response.is_success
        except Exception as error:  # the class only: provider errors may echo secrets
            result["error"] = type(error).__name__
        result["latency_ms"] = round((time.monotonic() - started) * 1000)
        self.journal.audit(actor, "settings_test", f"{target}:{'ok' if result['ok'] else 'failed'}")
        return result

    # -- events ---------------------------------------------------------------------------
    def record(self, event, applied=True):
        """Write an event after its operation completed; surface a failed write explicitly."""
        try:
            return self.journal.append_event(event)
        except Exception:
            raise AuditGap(applied) from None

    def decide(self, updated, *events):
        """Apply a change to the graph and record its events; intents bridge a crash between."""
        intents = [self.journal.intend(event) for event in events]
        try:
            self.commit(updated)
        except BaseException:
            for intent in intents:
                self.journal.abandon(intent)  # graph unchanged: no event, no leftover intent
            raise
        try:
            for event, intent in zip(events, intents, strict=True):
                self.journal.complete(event, intent)
        except Exception:
            raise AuditGap(True) from None  # intents stay; recover() writes the true events later

    def recover(self):
        """Resolve intents left by an interrupted decision, using the projection as the witness.

        Projection already in the intended state and the log not -> the graph commit happened, so
        the decision's own event is written (original actor and previous state, recorded now).
        Projection not in the intended state -> the commit never happened; the intent is dropped.
        """
        done = 0
        for intent, event in self.journal.intents():
            kind, ident = event["subject"]["kind"], event["subject"]["identifier"]
            table = self.state["nodes" if kind == "node" else "edges"]
            record = table.get(ident)
            last = self.journal.last_state(f"{kind}:{ident}")
            if (
                record
                and record["status"] == event["new_state"]
                and (last is None or last[0] != event["new_state"])
            ):
                self.journal.complete(event, intent)
                done += 1
            else:
                self.journal.abandon(intent)
        return done

    def reconcile_events(self):
        """Make the projection and the event log agree without inventing history.

        A candidate with no event, or whose state differs from its last state-setting event, gets
        an explicit ``candidate.snapshot``: occurred_at is null (unknown) and recorded_at is when
        this state was observed. Transitions that happened earlier are not reconstructed.
        """
        run = "reconcile-" + uuid4().hex[:12]
        count = 0
        for kind, records in (("node", self.state["nodes"]), ("link", self.state["edges"])):
            for record in records.values():
                subject = f"{kind}:{record['id']}"
                last = self.journal.last_state(subject)
                if last is not None and last[0] == record["status"]:
                    continue
                origin = "baseline_snapshot" if last is None else "reconciliation"
                note = (
                    "State observed when audit events were first enabled; earlier history unknown."
                    if last is None
                    else "Projection state differed from the last recorded event; transition unknown."
                )
                self.record(
                    ev.build(
                        "candidate.snapshot",
                        actor=SYSTEM,
                        subject={"kind": kind, "identifier": record["id"]},
                        correlation_id=run,
                        previous_state=None if last is None else last[0],
                        new_state=record["status"],
                        provenance=sources_of(record),
                        data={"basis": origin, "note": note},
                        occurred_at=None,
                    )
                )
                count += 1
        return count

    def extraction_origin(self, episode_id, message):
        client = self.journal.ingest_client(episode_id)
        if message.extraction is not None:
            return (
                {"kind": "client_supplied_extraction", "supplied_by_client": client},
                {
                    "kind": "system",
                    "identifier": f"client:{client}" if client else ev.SYSTEM_ACTOR,
                    "assurance": "bearer_token" if client else "none",
                },
            )
        host = urlparse(self.settings.model_base_url).hostname
        return (
            {
                "kind": "llm_extraction",
                "supplied_by_client": client,
                "model": self.settings.model_name,
                "provider": host,
            },
            {"kind": "model", "identifier": self.settings.model_name, "assurance": "internal"},
        )

    def contribution_events(self, state, episode_id, message):
        """created / evidence_added events for everything this source contributed to; idempotent."""
        origin, actor = self.extraction_origin(episode_id, message)
        events = []
        for kind, records in (("node", state["nodes"]), ("link", state["edges"])):
            for record in records.values():
                if not any(e["episode_id"] == episode_id for e in record["evidence"]):
                    continue
                subject = f"{kind}:{record['id']}"
                if self.journal.has_contribution(subject, episode_id):
                    continue
                first = not self.journal.subject_events(subject)
                common = {
                    "actor": actor,
                    "subject": {"kind": kind, "identifier": record["id"]},
                    "correlation_id": episode_id,
                    "provenance": sources_of(record),
                }
                if first:
                    events.append(
                        ev.build(
                            "candidate.created",
                            new_state=record["status"],
                            data={
                                "candidate_kind": record.get("kind") or record["relation"],
                                "origin": origin,
                                "evidence_count": len(record["evidence"]),
                            },
                            **common,
                        )
                    )
                else:
                    events.append(
                        ev.build(
                            "candidate.evidence_added",
                            data={"origin": origin, "evidence_count": len(record["evidence"])},
                            **common,
                        )
                    )
        return events

    def decision_event(self, kind, record, previous, status, actor, correlation_id):
        return ev.build(
            "candidate." + status,
            actor=principal(actor),
            subject={"kind": kind, "identifier": record["id"]},
            previous_state=previous,
            new_state=status,
            provenance=sources_of(record),
            correlation_id=correlation_id or uuid4().hex,
            data={},
        )

    def proposal_events(self, edges, correlation_id):
        events = []
        for edge in edges:
            method = edge["proposal"]["method"]
            judge = method == "judge"
            origin = {
                "kind": method if method in {"judge", "temporal"} else "similarity",
                "score": edge["proposal"]["score"],
            }
            if judge:
                origin["model"] = self.settings.effective_advice_model
                origin["provider"] = urlparse(self.settings.model_base_url).hostname
            events.append(
                ev.build(
                    "candidate.created",
                    actor={
                        "kind": "model",
                        "identifier": self.settings.effective_advice_model,
                        "assurance": "internal",
                    }
                    if judge
                    else SYSTEM,
                    subject={"kind": "link", "identifier": edge["id"]},
                    new_state="candidate",
                    provenance=sources_of(edge),
                    correlation_id=correlation_id,
                    data={
                        "candidate_kind": edge["relation"],
                        "origin": origin,
                        "evidence_count": len(edge["evidence"]),
                    },
                )
            )
        return events

    def ingest(self, message, actor):
        # Minimal known credential filter. This does not certify arbitrary raw messages as secret-free.
        if re.search(
            r"(?:sk-[A-Za-z0-9_-]{20,}|-----BEGIN .*PRIVATE KEY-----|"
            r"(?i:password|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{8,})",
            message.content,
        ):
            raise ValueError("possible credential detected; redact before ingestion")
        return self.journal.ingest(message, actor)

    async def process_one(self):
        async with self.lock:
            episode_id = self.journal.claim()
            if not episode_id:
                return False
            payload = self.journal.get(episode_id)
            if not payload:
                return False
            try:
                message = Message.model_validate(payload)
                extraction = message.extraction
                # Assistant/tool/system text is kept as raw provenance, not auto-promoted to knowledge.
                if extraction is None and self.extractor and message.role == "user":
                    themes = [
                        n["label"] for n in self.state["nodes"].values() if n["kind"] == "Theme"
                    ]
                    extraction = await self.extractor.extract(message, themes)
                if self.graphiti and message.role == "user":
                    await self.graphiti.add(episode_id, message)
                updated = copy.deepcopy(self.state)
                before = set(updated["nodes"])
                add_extraction(updated, episode_id, message, extraction or Extraction())
                self.commit(updated)
                # Events and the done mark share one SQLite transaction. If it fails the job is
                # retried and the idempotent contribution check writes only what is still missing.
                self.journal.finish(
                    episode_id, events=self.contribution_events(updated, episode_id, message)
                )
                if self.settings.auto_propose:
                    # Best effort and separate from ingestion: a provider failure must not fail the job.
                    try:
                        await self._propose(before=before)
                    except Exception as error:
                        self.journal.audit("system", "auto_propose_failed", type(error).__name__)
            except Exception as error:
                # Only exception class is persisted; upstream errors may contain sensitive text.
                self.journal.finish(episode_id, type(error).__name__)
            return True

    def commit(self, state):
        self.graph.save(state)
        self.state = state

    async def worker(self):
        while True:
            processed = await self.process_one()
            if not processed:
                async with self.lock:
                    self.recover()
                await asyncio.sleep(self.settings.poll_seconds)

    async def review(self, node_id, status, actor, expected=None, correlation_id=None):
        async with self.lock:
            if node_id not in self.state["nodes"]:
                raise KeyError(node_id)
            current = self.state["nodes"][node_id]["status"]
            if expected is not None and expected != current:
                raise Conflict(f"candidate is {current}, not {expected}")
            if current == status:
                return self.state["nodes"][node_id]  # repeated review: no change, no event
            updated = copy.deepcopy(self.state)
            updated["nodes"][node_id]["status"] = status
            # Review does not silently validate relations or other claims.
            self.recover()
            self.decide(
                updated,
                self.decision_event(
                    "node", updated["nodes"][node_id], current, status, actor, correlation_id
                ),
            )
            return updated["nodes"][node_id]

    async def add_link(self, link, actor):
        async with self.lock:
            if link.source_id == link.target_id:
                raise ValueError("self links are not supported")
            if any(key not in self.state["nodes"] for key in (link.source_id, link.target_id)):
                raise KeyError("unknown node")
            episode = self.journal.get(link.episode_id)
            if not episode or link.quote not in episode["content"]:
                raise ValueError("link needs an exact quote in a live source episode")
            edge_id = identity(
                link.source_id, link.relation, link.target_id, link.episode_id, link.quote
            )
            if edge_id in self.state["edges"]:
                return self.state["edges"][edge_id]  # same proposal again: no reset, no new event
            updated = copy.deepcopy(self.state)
            updated["edges"][edge_id] = {
                "id": edge_id,
                **link.model_dump(mode="json"),
                "status": "candidate",
                "evidence": [{"episode_id": link.episode_id, "quote": link.quote}],
            }
            edge = updated["edges"][edge_id]
            self.recover()
            self.decide(
                updated,
                ev.build(
                    "candidate.created",
                    actor=principal(actor),
                    subject={"kind": "link", "identifier": edge_id},
                    new_state="candidate",
                    provenance=sources_of(edge),
                    correlation_id=uuid4().hex,
                    data={
                        "candidate_kind": edge["relation"],
                        "origin": {"kind": "manual", "supplied_by_client": actor},
                        "evidence_count": 1,
                    },
                ),
            )
            return edge

    async def review_link(self, edge_id, status, actor, expected=None, correlation_id=None):
        async with self.lock:
            if edge_id not in self.state["edges"]:
                raise KeyError(edge_id)
            current = self.state["edges"][edge_id]["status"]
            if expected is not None and expected != current:
                raise Conflict(f"candidate is {current}, not {expected}")
            if current == status:
                return self.state["edges"][edge_id]
            updated = copy.deepcopy(self.state)
            edge = updated["edges"][edge_id]
            # A change relation is information; temporal windows remain explicit reviewed data.
            edge["status"] = status
            if status == "rejected" and edge.get("origin") == "proposal":
                edge["rejected_at"] = utcnow().isoformat()
            self.recover()
            self.decide(
                updated, self.decision_event("link", edge, current, status, actor, correlation_id)
            )
            return edge

    async def propose_links(self, actor):
        async with self.lock:
            report = await self._propose()
            self.journal.audit(actor, "propose_links", f"{report['proposed']}")
            return report

    async def _propose(self, before=None):
        """Create candidate edges. ``before``: node ids already examined (only new ones are paired)."""
        s = self.settings
        updated = copy.deepcopy(self.state)
        only_ids = None
        if before is not None:
            only_ids = set(updated["nodes"]) - before
            if not only_ids:
                return {"proposed": 0, "edges": [], "skipped": {}, "usage": {}}
        vectors = {}
        if self.embedder:
            missing = [
                n
                for n in updated["nodes"].values()
                if n["status"] != "rejected" and not usable_vector(n, self.embedder.model)
            ]
            if missing:
                for node, vector in zip(
                    missing,
                    await self.embedder.embed([embedding_text(n) for n in missing]),
                    strict=True,
                ):
                    node["embedding"] = {
                        "model": self.embedder.model,
                        "dim": len(vector),
                        "text_hash": text_hash(node),
                        "vector": unit(vector),
                    }
            vectors = {
                n["id"]: usable_vector(n, self.embedder.model) for n in updated["nodes"].values()
            }
            vectors = {k: v for k, v in vectors.items() if v}
        verdicts = None
        if self.judge:
            verdicts = {}
            ranked = sorted(
                candidate_pairs(updated, vectors, s.effective_threshold, only_ids),
                key=lambda row: -row[2],
            )[: s.max_judge_calls]
            for a, b, _, _ in ranked:
                try:
                    verdicts[pair_id(a, b)] = await self.judge.judge(
                        a, b, recent_evidence(a), recent_evidence(b)
                    )
                except Exception as error:  # an invalid verdict is dropped, never guessed
                    self.journal.audit("system", "judge_rejected", type(error).__name__)
        new, skipped = propose(updated, vectors, s.effective_threshold, verdicts, only_ids)
        updated["edges"].update(new)
        self.decide(
            updated, *self.proposal_events(list(new.values()), "propose-" + uuid4().hex[:12])
        )
        usage = {
            "embedder": getattr(self.embedder, "usage", {}),
            "judge": getattr(self.judge, "usage", {}),
        }
        return {
            "proposed": len(new),
            "edges": sorted(new),
            "skipped": skipped,
            "threshold": s.effective_threshold,
            "mode": s.similarity_mode + ("+judge" if self.judge else ""),
            "usage": usage,
        }

    async def consolidate(self, actor):
        async with self.lock:
            updated = copy.deepcopy(self.state)
            report = consolidate(updated)
            self.commit(updated)
            self.journal.audit(actor, "consolidate", self.settings.scope)
            return report

    async def erase(self, episode_id, actor, correlation_id=None):
        async with self.lock:
            payload = self.journal.get(episode_id)
            if not payload:
                raise KeyError(episode_id)
            if self.graphiti and payload["role"] == "user":
                await self.graphiti.rebuild_without(episode_id, self.journal)
            updated = copy.deepcopy(self.state)
            citing = [
                f"{kind}:{r['id']}"
                for kind, table in (("node", self.state["nodes"]), ("link", self.state["edges"]))
                for r in table.values()
                if any(e["episode_id"] == episode_id for e in r["evidence"])
            ]
            remove_episode(updated, episode_id)
            self.commit(updated)
            cleaned = ["live_journal", "active_graph"] + (
                ["graphiti_projection"] if self.graphiti else []
            )
            # The event row is written in the same SQLite transaction that blanks the raw text.
            self.journal.erase(
                episode_id,
                actor,
                purge=citing,
                event=ev.build(
                    "source.deleted",
                    actor=principal(actor),
                    subject={"kind": "source", "identifier": episode_id},
                    previous_state="live",
                    new_state="deleted",
                    correlation_id=correlation_id or uuid4().hex,
                    data={"derived_stores_cleaned": cleaned},
                ),
            )

    def record_context(self, client_id, request, result, correlation_id=None):
        """Event for a finished context assembly; called before the result is released."""
        refs = [{"kind": "node", "id": item["id"]} for item in result["items"]]
        self.record(
            ev.build(
                "context.assembled",
                actor={"kind": "system", "identifier": client_id, "assurance": "bearer_token"},
                subject={"kind": "memory_scope", "identifier": self.settings.scope},
                provenance=refs,
                correlation_id=correlation_id or uuid4().hex,
                data={
                    "requester": client_id,
                    "items_returned": len(result["items"]),
                    "max_chars_requested": request.max_chars,
                    "chars_used": result["used_chars"],
                    "truncated": result["truncated"],
                    "include_candidates": request.include_candidates,
                    "as_of": request.as_of.isoformat() if request.as_of else None,
                    "target_assistant": None,
                },
            ),
            applied=False,
        )

    # -- candidate queue (a read model over the projection and the event log) ------------
    def candidate_view(self, kind, record, recs=None):
        view = self._candidate_core(kind, record)
        recs = self.journal.recommendations() if recs is None else recs
        advice = self.recommendation_view(kind, record, recs.get(f"{kind}:{record['id']}"))
        view["recommendation"] = advice
        view["recommendation_agrees"] = None
        decision = view["decision"]
        if advice and not advice["stale"] and decision and advice["recommendation"] != "unsure":
            wanted = (
                "candidate.confirmed"
                if advice["recommendation"] == "confirm"
                else "candidate.rejected"
            )
            view["recommendation_agrees"] = decision["type"] == wanted
        return view

    # -- model recommendations (advice only; AM-021) ---------------------------------------
    @staticmethod
    def fingerprint(kind, record):
        basis = [
            kind,
            record["id"],
            record.get("label"),
            record.get("summary"),
            record.get("relation"),
        ]
        basis.append(sorted((e["episode_id"], e["quote"]) for e in record["evidence"]))
        return hashlib.sha256(json.dumps(basis, ensure_ascii=False).encode()).hexdigest()[:32]

    def recommendation_view(self, kind, record, row):
        if not row:
            return None
        return {
            "recommendation": row["recommendation"],
            "confidence": row["confidence"],
            "reason": row["reason"],
            "model": row["model"],
            "provider": row["provider"],
            "recorded_at": ev.iso(row["recorded"]),
            "sequence": row["sequence"],
            "stale": row["fingerprint"] != self.fingerprint(kind, record),
        }

    def describe_for_model(self, kind, record):
        evidence = [{"quote": e["quote"], "role": e.get("role")} for e in record["evidence"][:5]]
        if kind == "node":
            return {
                "proposal": "node",
                "kind": record["kind"],
                "label": record["label"],
                "summary": record["summary"],
                "evidence": evidence,
            }
        nodes = self.state["nodes"]

        def end(key):
            node = nodes[record[key + "_id"]]
            return {"kind": node["kind"], "label": node["label"]}

        return {
            "proposal": "relation",
            "relation": record["relation"],
            "source": end("source"),
            "target": end("target"),
            "evidence": evidence,
        }

    def recommend_start(self, limit, actor):
        if not self.recommender:
            raise ValueError("model recommendations are not enabled (Nastavení)")
        if self.recommend_state["running"]:
            raise Conflict("a recommendation run is already in progress")
        self.recommend_state = {"running": True, "done": 0, "total": 0, "failed": 0, "report": None}
        self._recommend_task = asyncio.create_task(self._recommend_job(limit, actor))
        return self.recommend_state

    async def _recommend_job(self, limit, actor):
        state = self.recommend_state
        try:
            state["report"] = await self.recommend_now(limit, actor, state)
        except Exception as error:  # class only; provider errors may echo secrets
            state["report"] = {"error": type(error).__name__}
        finally:
            state["running"] = False

    async def recommend_now(self, limit, actor, progress=None):
        """Ask the model about candidates without current advice. Never changes a status."""
        if not self.recommender:
            raise ValueError("model recommendations are not enabled (Nastavení)")
        self.recommender.transport = self.http_transport
        limit = min(limit, self.settings.max_recommend_calls)
        progress = progress if progress is not None else {}
        run = "recommend-" + uuid4().hex[:12]
        async with self.lock:
            existing = self.journal.recommendations()
            work, waiting = [], 0
            for _, kind, record in self._candidate_rows("all", "candidate", None):
                fingerprint = self.fingerprint(kind, record)
                row = existing.get(f"{kind}:{record['id']}")
                if row and row["fingerprint"] == fingerprint:
                    continue
                if len(work) < limit:
                    work.append(
                        (kind, record["id"], fingerprint, self.describe_for_model(kind, record))
                    )
                else:
                    waiting += 1
            model = self.settings.effective_advice_model
            host = urlparse(self.settings.model_base_url).hostname
        progress.update(total=len(work), done=0, failed=0)
        counts = {"confirm": 0, "reject": 0, "unsure": 0}
        void = 0
        for kind, record_id, fingerprint, description in work:
            try:
                answer = await self.recommender.recommend(description)
            except Exception as error:
                progress["failed"] += 1
                progress["done"] += 1
                self.journal.audit("system", "recommend_failed", type(error).__name__)
                continue
            async with self.lock:
                table = self.state["nodes"] if kind == "node" else self.state["edges"]
                record = table.get(record_id)
                if (
                    not record
                    or record["status"] != "candidate"
                    or self.fingerprint(kind, record) != fingerprint
                ):
                    void += 1  # decided or edited while the model was thinking: the advice is void
                else:
                    try:
                        self.journal.save_recommendation(
                            f"{kind}:{record_id}",
                            fingerprint,
                            answer,
                            ev.build(
                                "candidate.recommended",
                                actor={
                                    "kind": "model",
                                    "identifier": model,
                                    "assurance": "internal",
                                },
                                subject={"kind": kind, "identifier": record_id},
                                provenance=sources_of(record),
                                correlation_id=run,
                                data={
                                    "recommendation": answer.recommendation,
                                    "confidence": answer.confidence,
                                    "model": model,
                                    "provider": host,
                                    "evidence_fingerprint": fingerprint,
                                },
                            ),
                        )
                        counts[answer.recommendation] += 1
                    except Exception as error:
                        progress["failed"] += 1
                        self.journal.audit("system", "recommend_failed", type(error).__name__)
            progress["done"] += 1
        self.journal.audit(actor, "recommend_run", f"{sum(counts.values())}/{len(work)}")
        return {
            "considered": len(work),
            "recommended": counts,
            "failed": progress["failed"],
            "void_because_changed": void,
            "still_without_advice": waiting,
            "model": model,
            "provider": host,
        }

    def recommendation_summary(self):
        rows = self.journal.recommendations()
        open_counts = {"confirm": 0, "reject": 0, "unsure": 0, "stale": 0, "none": 0}
        agreement = {"agreed": 0, "disagreed": 0, "unsure": 0}
        for kind, table in (("node", self.state["nodes"]), ("link", self.state["edges"])):
            for record in table.values():
                row = rows.get(f"{kind}:{record['id']}")
                current = bool(row) and row["fingerprint"] == self.fingerprint(kind, record)
                if record["status"] == "candidate":
                    if not row:
                        open_counts["none"] += 1
                    elif not current:
                        open_counts["stale"] += 1
                    else:
                        open_counts[row["recommendation"]] += 1
                elif current:
                    if row["recommendation"] == "unsure":
                        agreement["unsure"] += 1
                    else:
                        wanted = "confirmed" if row["recommendation"] == "confirm" else "rejected"
                        agreement["agreed" if record["status"] == wanted else "disagreed"] += 1
        return {
            "open_candidates": open_counts,
            "decided_with_advice": agreement,
            "enabled": bool(self.recommender),
            "model": self.settings.effective_advice_model if self.recommender else None,
            "provider": urlparse(self.settings.model_base_url).hostname
            if self.recommender
            else None,
            "max_per_run": self.settings.max_recommend_calls,
            "run": self.recommend_state,
        }

    def _candidate_core(self, kind, record):
        subject = f"{kind}:{record['id']}"
        history = self.journal.subject_events(subject)
        contributions = [
            {
                "event_id": e["event_id"],
                "sequence": e["sequence"],
                "type": e["type"],
                "recorded_at": e["recorded_at"],
                "actor": e["actor"],
                "origin": e["data"].get("origin"),
                "basis": e["data"].get("basis"),
                "sources": [r["id"] for r in e["provenance"]],
            }
            for e in history
            if e["type"] in {"candidate.created", "candidate.evidence_added", "candidate.snapshot"}
        ]
        last_state = self.journal.last_state(subject)
        nodes = self.state["nodes"]
        view = {
            "subject": {"kind": kind, "identifier": record["id"]},
            "candidate_kind": record.get("kind") or record["relation"],
            "status": record["status"],
            "evidence": [
                {
                    k: e.get(k)
                    for k in (
                        "episode_id",
                        "quote",
                        "role",
                        "occurred_at",
                        "source_system",
                        "conversation_id",
                        "message_id",
                        "url",
                    )
                }
                for e in record["evidence"]
            ],
            "contributions": contributions,
            "decision": next(
                (
                    {
                        "event_id": e["event_id"],
                        "type": e["type"],
                        "recorded_at": e["recorded_at"],
                        "actor": e["actor"],
                        "previous_state": e["previous_state"],
                    }
                    for e in reversed(history)
                    if e["type"] in {"candidate.confirmed", "candidate.rejected"}
                ),
                None,
            ),
            "audit": {
                "events": len(history),
                "first_sequence": history[0]["sequence"] if history else None,
                "last_state_event_sequence": last_state[1] if last_state else None,
                "last_recorded_state": last_state[0] if last_state else None,
                "consistent": bool(last_state and last_state[0] == record["status"]),
            },
        }
        if kind == "node":
            view |= {
                k: record.get(k)
                for k in ("label", "summary", "confidence", "valid_from", "valid_to")
            }
        else:
            ends = {}
            for side in ("source", "target"):
                node = nodes.get(record[side + "_id"])
                ends[side] = (
                    {k: node[k] for k in ("id", "kind", "label", "summary", "status")}
                    if node
                    else None
                )
            view |= ends | {
                "relation": record["relation"],
                "proposal": record.get("proposal"),
                "origin": record.get("origin", "manual"),
            }
        return view

    def derived_by_source(self):
        """episode_id -> candidates that cite it. Built from the projection on each call (O(N))."""
        found = {}
        nodes = self.state["nodes"]
        for item_kind, records in (("node", nodes), ("link", self.state["edges"])):
            for record in records.values():
                if item_kind == "node":
                    title, candidate_kind = record["label"], record["kind"]
                elif record["relation"] == "ABOUT":
                    continue  # placement under a theme is not a decision; the queue leaves it out too
                else:
                    ends = (nodes.get(record["source_id"]), nodes.get(record["target_id"]))
                    title = " – ".join(n["label"] if n else "(uzel nedostupný)" for n in ends)
                    candidate_kind = record["relation"]
                for episode_id in {e["episode_id"] for e in record["evidence"]}:
                    quotes = [
                        e["quote"] for e in record["evidence"] if e["episode_id"] == episode_id
                    ]
                    found.setdefault(episode_id, []).append(
                        {
                            "subject": {"kind": item_kind, "identifier": record["id"]},
                            "candidate_kind": candidate_kind,
                            "title": title,
                            "status": record["status"],
                            "quotes": quotes,
                        }
                    )
        return found

    @staticmethod
    def conversation_title(themes, first_text):
        """Readable name: the most cited themes of the conversation, else the start of its first message."""
        ranked = [label for label, _ in sorted(themes.items(), key=lambda t: (-t[1], t[0]))[:3]]
        if ranked:
            return " · ".join(ranked)
        text = " ".join((first_text or "").split())
        return (text[:70].rstrip() + "…" if len(text) > 70 else text) or None

    def conversations(self, cursor=None, limit=25, q=None, source=None, sort="activity"):
        """Live conversations with a readable title, themes and a preview.

        ``sort``: ``activity`` = newest message time first, ``added`` = most recently added first
        (a pasted old conversation then still lands on top). ``q`` matches title, id, themes and
        message text (case-insensitive); ``source`` keeps one source system. Keyset cursor
        'sort key|source|conversation'.
        """
        if sort not in ("activity", "added"):
            raise ValueError("invalid sort")
        derived = self.derived_by_source()
        added = self.journal.ingest_times()
        groups = {}
        for episode_id, payload in self.journal.live_episodes():
            key = (payload["source_system"], payload["conversation_id"])
            group = groups.setdefault(
                key,
                {
                    "messages": 0,
                    "first_at": None,
                    "last_at": None,
                    "added": 0.0,
                    "items": {},
                    "themes": {},
                    "first": None,
                    "text": [],
                },
            )
            if payload["role"] == "user" and (
                group["first"] is None or payload["occurred_at"] < group["first"][0]
            ):
                group["first"] = (payload["occurred_at"], payload["content"])
            group["messages"] += 1
            group["text"].append(payload["content"])
            group["added"] = max(group["added"], added.get(episode_id, 0.0))
            stamp = payload["occurred_at"]
            group["first_at"] = min(filter(None, [group["first_at"], stamp]))
            group["last_at"] = max(filter(None, [group["last_at"], stamp]))
            for item in derived.get(episode_id, []):
                group["items"][(item["subject"]["kind"], item["subject"]["identifier"])] = item
                if item["candidate_kind"] == "Theme" and item["status"] != "rejected":
                    group["themes"][item["title"]] = group["themes"].get(item["title"], 0) + 1
        sources = sorted({source_system for source_system, _ in groups})
        needle = (q or "").strip().casefold()
        rows = []
        for (source_system, conversation_id), group in groups.items():
            if source and source_system != source:
                continue
            title = self.conversation_title(
                group["themes"], group["first"][1] if group["first"] else None
            )
            ranked = [t for t, _ in sorted(group["themes"].items(), key=lambda t: (-t[1], t[0]))]
            if needle:
                hay = " ".join(
                    [title or "", conversation_id, source_system, *ranked, *group["text"]]
                )
                if needle not in hay.casefold():
                    continue
            counts = {"candidate": 0, "confirmed": 0, "rejected": 0}
            for item in group["items"].values():
                counts[item["status"]] += 1
            first_text = " ".join((group["first"][1] if group["first"] else "").split())
            added_at = (
                datetime.fromtimestamp(group["added"], timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
                if group["added"]
                else group["last_at"]
            )
            rows.append(
                {
                    "source_system": source_system,
                    "conversation_id": conversation_id,
                    "title": title,
                    "preview": first_text[:180] + ("…" if len(first_text) > 180 else ""),
                    "themes": ranked[:4],
                    "messages": group["messages"],
                    "first_at": group["first_at"],
                    "last_at": group["last_at"],
                    "added_at": added_at,
                    "derived": counts,
                }
            )
        field = "added_at" if sort == "added" else "last_at"
        rows.sort(key=lambda r: (r[field], r["source_system"], r["conversation_id"]), reverse=True)
        if cursor:
            try:
                stamp, source_system, conversation_id = cursor.split("|", 2)
            except ValueError:
                raise ValueError("invalid cursor") from None
            after = (stamp, source_system, conversation_id)
            rows = [r for r in rows if (r[field], r["source_system"], r["conversation_id"]) < after]
        page = rows[:limit]
        more = len(rows) > limit
        last = page[-1] if page else None
        return {
            "conversations": page,
            "has_more": more,
            "next_cursor": (
                f"{last[field]}|{last['source_system']}|{last['conversation_id']}"
                if more and last
                else None
            ),
            "total": len(groups),
            "matching": len(rows) if not cursor else None,
            "sources": sources,
        }

    def conversation(self, source_system, conversation_id):
        """All live messages of one conversation, oldest first, with the candidates each produced."""
        derived = self.derived_by_source()
        messages = [
            {
                "episode_id": episode_id,
                "message_id": payload["message_id"],
                "role": payload["role"],
                "occurred_at": payload["occurred_at"],
                "content": payload["content"],
                "derived": derived.get(episode_id, []),
            }
            for episode_id, payload in self.journal.live_episodes()
            if payload["source_system"] == source_system
            and payload["conversation_id"] == conversation_id
        ]
        if not messages:
            raise KeyError(conversation_id)
        messages.sort(key=lambda m: (m["occurred_at"], m["message_id"]))
        themes = {}
        for m in messages:
            for item in m["derived"]:
                if item["candidate_kind"] == "Theme" and item["status"] != "rejected":
                    themes[item["title"]] = themes.get(item["title"], 0) + 1
        first = next((m["content"] for m in messages if m["role"] == "user"), None)
        return {
            "source_system": source_system,
            "conversation_id": conversation_id,
            "title": self.conversation_title(themes, first),
            "messages": messages,
        }

    def _conversation_episodes(self, source_system, conversation_id):
        ids = [
            (episode_id, payload["role"])
            for episode_id, payload in self.journal.live_episodes()
            if payload["source_system"] == source_system
            and payload["conversation_id"] == conversation_id
        ]
        if not ids:
            raise KeyError(conversation_id)
        return ids

    def reprocess_conversation(self, source_system, conversation_id, actor):
        """Run the user's messages of one conversation through the model again.

        Additive: existing candidates keep their status and nothing is removed; only new items and
        new evidence appear. Needs a configured model (otherwise there is nothing new to find).
        """
        episodes = self._conversation_episodes(source_system, conversation_id)
        if self.extractor is None:
            raise RuntimeError("model extraction is not configured")
        if self.graphiti is not None:
            raise RuntimeError("reprocessing is not supported with the Graphiti projection")
        users = [episode_id for episode_id, role in episodes if role == "user"]
        return {"queued": self.journal.requeue(users, actor), "user_messages": len(users)}

    async def erase_conversation(self, source_system, conversation_id, actor, correlation_id=None):
        """Delete every message of a conversation and what was derived only from them."""
        episodes = self._conversation_episodes(source_system, conversation_id)
        for episode_id, _ in episodes:
            await self.erase(episode_id, actor, correlation_id)
        return len(episodes)

    def _candidate_rows(self, kind, status, relation, exclude_relation=None):
        """Candidates in stable queue order: (first event sequence, kind, id); unaudited last."""
        rows = []
        firsts = self.journal.first_sequences()
        for item_kind, records in (("node", self.state["nodes"]), ("link", self.state["edges"])):
            if kind not in ("all", item_kind):
                continue
            for record in records.values():
                if status != "all" and record["status"] != status:
                    continue
                if relation and (record.get("relation") != relation):
                    continue
                if exclude_relation and record.get("relation") == exclude_relation:
                    continue
                if item_kind == "link" and not all(
                    record[s + "_id"] in self.state["nodes"] for s in ("source", "target")
                ):
                    continue
                key = (firsts.get(f"{item_kind}:{record['id']}", 10**15), item_kind, record["id"])
                rows.append((key, item_kind, record))
        rows.sort(key=lambda r: r[0])
        return rows

    def candidates(
        self,
        kind="all",
        status="candidate",
        relation=None,
        cursor=None,
        limit=50,
        advice=None,
        exclude_relation=None,
    ):
        """Stable keyset page. ``advice``: confirm|reject|unsure|none|stale filters by model advice."""
        rows = self._candidate_rows(kind, status, relation, exclude_relation)
        recs = self.journal.recommendations()
        if advice:

            def matches(item):
                _, item_kind, record = item
                row = recs.get(f"{item_kind}:{record['id']}")
                if advice == "none":
                    return row is None
                if row is None:
                    return False
                stale = row["fingerprint"] != self.fingerprint(item_kind, record)
                return (
                    stale if advice == "stale" else (not stale and row["recommendation"] == advice)
                )

            rows = [r for r in rows if matches(r)]
        total = len(rows)
        if cursor:
            after = parse_cursor(cursor)
            rows = [r for r in rows if r[0] > after]
        page = rows[:limit]
        more = len(rows) > limit
        items = [self.candidate_view(k, r, recs) for _, k, r in page]
        last = page[-1][0] if page else None
        return {
            "items": items,
            "total": total,
            "has_more": more,
            "next_cursor": f"{last[0]}:{last[1]}:{last[2]}" if more and last else None,
        }

    def subject_view(self, subject):
        """Read-time label of an event subject from the projection; never stored in events."""
        records = {"node": self.state["nodes"], "link": self.state["edges"]}.get(subject["kind"])
        record = (records or {}).get(subject["identifier"])
        if not record:
            return {"available": False}
        if subject["kind"] == "node":
            return {
                "available": True,
                "candidate_kind": record["kind"],
                "label": record["label"],
                "status": record["status"],
            }
        nodes = self.state["nodes"]
        ends = [nodes.get(record[s + "_id"], {}).get("label") for s in ("source", "target")]
        return {
            "available": True,
            "candidate_kind": record["relation"],
            "status": record["status"],
            "label": f"{ends[0]} → {ends[1]}",
        }

    def candidate(self, kind, record_id):
        records = self.state["nodes"] if kind == "node" else self.state["edges"]
        if record_id not in records:
            raise KeyError(record_id)
        return self.candidate_view(kind, records[record_id])

    async def close(self):
        if self._recommend_task and not self._recommend_task.done():
            self._recommend_task.cancel()
        self.graph.close()
        if self.graphiti:
            await self.graphiti.close()
