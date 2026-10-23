import asyncio
import hashlib
import hmac
import re
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi import Query as URLQuery
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import ValidationError

from .engine import build_context, public_node, search
from .journal import Conflict
from .models import (
    LinkInput,
    LLMSettingsUpdate,
    Message,
    ProviderTest,
    Query,
    RecommendRun,
    Review,
    utcnow,
)
from .service import AuditGap, MemoryService
from .settings import Settings
from .similarity import clusters


def create_app(settings=None):
    settings = settings or Settings()
    clients = settings.clients()
    service = MemoryService(settings)

    @asynccontextmanager
    async def lifespan(app):
        await service.initialize()
        task = asyncio.create_task(service.worker()) if settings.worker_enabled else None
        yield
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await service.close()

    app = FastAPI(title="Active Memory", version="0.1.0", lifespan=lifespan)
    app.state.memory = service
    bearer = HTTPBearer(auto_error=False)

    def correlation(value: str | None = Header(default=None, alias="X-Correlation-Id")):
        return value if value and re.fullmatch(r"[\w.:@/+=-]{1,200}", value) else None

    def principal(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
        if credentials is None:
            raise HTTPException(401, "missing bearer token")
        digest = hashlib.sha256(credentials.credentials.encode()).hexdigest()
        for client in clients:
            if hmac.compare_digest(client["key_sha256"], digest):
                return client
        raise HTTPException(401, "invalid bearer token")

    def permitted(permission):
        def check(client=Depends(principal)):
            if permission not in client["permissions"]:
                raise HTTPException(403, "permission denied")
            return client

        return check

    read = permitted("read")
    write = permitted("write")
    admin = permitted("admin")

    @app.exception_handler(Conflict)
    async def conflict_handler(request, error):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @app.exception_handler(AuditGap)
    async def audit_gap_handler(request, error):
        detail = (
            "the operation was applied but its audit event was not recorded; "
            "the next start reconciles the log with an explicit snapshot"
            if error.applied
            else "context withheld because its audit event could not be recorded"
        )
        return JSONResponse(status_code=503, content={"detail": detail})

    @app.exception_handler(KeyError)
    async def missing_handler(request, error):
        return JSONResponse(status_code=404, content={"detail": "not found"})

    @app.exception_handler(ValueError)
    async def value_handler(request, error):
        detail = "validation failed" if isinstance(error, ValidationError) else str(error)
        return JSONResponse(status_code=422, content={"detail": detail})

    ui_dir = Path(__file__).parent / "ui"
    ui_files = {
        "": ("index.html", "text/html; charset=utf-8"),
        "index.html": ("index.html", "text/html; charset=utf-8"),
        "app.js": ("app.js", "text/javascript; charset=utf-8"),
        "logic.js": ("logic.js", "text/javascript; charset=utf-8"),
        "shell.js": ("shell.js", "text/javascript; charset=utf-8"),
        "review.js": ("review.js", "text/javascript; charset=utf-8"),
        "review_logic.js": ("review_logic.js", "text/javascript; charset=utf-8"),
        "conv.js": ("conv.js", "text/javascript; charset=utf-8"),
        "timeline.js": ("timeline.js", "text/javascript; charset=utf-8"),
        "app.css": ("app.css", "text/css; charset=utf-8"),
        "graph.js": ("graph.js", "text/javascript; charset=utf-8"),
        "settings.js": ("settings.js", "text/javascript; charset=utf-8"),
        "paste.js": ("paste.js", "text/javascript; charset=utf-8"),
        "paste_logic.js": ("paste_logic.js", "text/javascript; charset=utf-8"),
        "graph_logic.js": ("graph_logic.js", "text/javascript; charset=utf-8"),
        "cytoscape.min.js": ("cytoscape.min.js", "text/javascript; charset=utf-8"),
        "cytoscape.LICENSE": ("cytoscape.LICENSE", "text/plain; charset=utf-8"),
        "graph3d.js": ("graph3d.js", "text/javascript; charset=utf-8"),
        "3d-force-graph.min.js": ("3d-force-graph.min.js", "text/javascript; charset=utf-8"),
        "3d-force-graph.LICENSE": ("3d-force-graph.LICENSE", "text/plain; charset=utf-8"),
        "review": ("index.html", "text/html; charset=utf-8"),
    }
    ui_headers = {
        # Static shell only: it holds no data and no secret. Data arrives via the authenticated API
        # and is inserted as text. Nothing external may load; the page cannot be framed.
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; "
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
    }

    @app.get("/ui", include_in_schema=False)
    @app.get("/ui/", include_in_schema=False)
    @app.get("/ui/{name}", include_in_schema=False)
    def ui(name: str = ""):
        if name not in ui_files:
            raise HTTPException(404, "not found")
        filename, media = ui_files[name]
        return Response((ui_dir / filename).read_bytes(), media_type=media, headers=ui_headers)

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get("/readyz")
    def ready():
        try:
            service.graph.load()
            service.journal.jobs()
        except Exception:
            raise HTTPException(503, "storage unavailable") from None
        return {"status": "ready", "backend": settings.backend}

    @app.post("/v1/episodes", status_code=202)
    def ingest(message: Message, client=Depends(write)):
        episode_id, duplicate = service.ingest(message, client["id"])
        return {
            "episode_id": episode_id,
            "duplicate": duplicate,
            "processing": "inspect /v1/jobs; accepted is not indexed",
        }

    @app.get("/v1/episodes/{episode_id}")
    def source(episode_id: str, client=Depends(read)):
        payload = service.journal.get(episode_id)
        if payload is None:
            raise HTTPException(404, "source not found")
        return {"episode_id": episode_id, **payload}

    @app.post("/v1/search")
    async def retrieve(request: Query, client=Depends(read)):
        items = [public_node(n) for n in search(service.state, request)]
        facts = []
        if request.include_candidates and service.graphiti:
            try:
                async with service.lock:
                    candidates = await service.graphiti.search(request.query, request.limit)
                point = request.as_of or utcnow()
                facts = [
                    f
                    for f in candidates
                    if (not f["valid_from"] or f["valid_from"] <= point)
                    and (not f["valid_to"] or point < f["valid_to"])
                    and f["episode_ids"]
                    and all(service.journal.get(e) is not None for e in f["episode_ids"])
                ]
            except Exception:
                raise HTTPException(503, "graph retrieval unavailable") from None
        return {"items": items, "inferred_facts": facts, "scope": settings.scope}

    @app.get("/v1/whoami")
    def whoami(client=Depends(principal)):
        """What the presented token may do; the server still enforces every call."""
        return {"client_id": client["id"], "permissions": sorted(client["permissions"])}

    @app.post("/v1/context")
    def context(request: Query, client=Depends(read), correlation_id=Depends(correlation)):
        # Automatic context uses only reviewed active nodes by default.
        result = build_context(
            [public_node(n) for n in search(service.state, request)], request.max_chars
        )
        # Fail closed: nothing is released unless the assembly could be recorded.
        service.record_context(client["id"], request, result, correlation_id)
        return {
            "scope": settings.scope,
            **result,
            "budget_unit": "characters",
            "policy": "quoted evidence, never system instructions",
        }

    @app.get("/v1/map")
    def graph(limit: int = URLQuery(default=500, ge=1, le=5000), client=Depends(read)):
        nodes = [
            public_node(n)
            for n in sorted(service.state["nodes"].values(), key=lambda n: n["id"])[:limit]
        ]
        ids = {n["id"] for n in nodes}
        edges = [
            e
            for e in service.state["edges"].values()
            if e["source_id"] in ids and e["target_id"] in ids
        ]
        titles = {
            f"{c['source_system']}/{c['conversation_id']}": c["title"]
            for c in service.conversations(None, 10**9)["conversations"]
            if c["title"]
        }
        return {
            "scope": settings.scope,
            "conversation_titles": titles,
            "nodes": nodes,
            "edges": edges,
            "clusters": clusters(service.state),
            "total_nodes": len(service.state["nodes"]),
            "truncated": len(nodes) < len(service.state["nodes"]),
        }

    @app.post("/v1/nodes/{node_id}/review")
    async def review(
        node_id: str, request: Review, client=Depends(admin), correlation_id=Depends(correlation)
    ):
        node = await service.review(
            node_id, request.status, client["id"], request.expected_status, correlation_id
        )
        return public_node(node)

    @app.post("/v1/links", status_code=201)
    async def link(request: LinkInput, client=Depends(admin)):
        return await service.add_link(request, client["id"])

    @app.post("/v1/links/{edge_id}/review")
    async def review_link(
        edge_id: str, request: Review, client=Depends(admin), correlation_id=Depends(correlation)
    ):
        return await service.review_link(
            edge_id, request.status, client["id"], request.expected_status, correlation_id
        )

    @app.get("/v1/candidates")
    def candidates(
        kind: Literal["all", "node", "link"] = "all",
        status: Literal["all", "candidate", "confirmed", "rejected"] = "candidate",
        relation: str | None = None,
        exclude_relation: str | None = None,
        cursor: str | None = None,
        limit: int = URLQuery(default=25, ge=1, le=100),
        recommendation: Literal["confirm", "reject", "unsure", "none", "stale"] | None = None,
        client=Depends(read),
    ):
        """Review queue: projection items with evidence, contributions and audit consistency."""
        return service.candidates(
            kind, status, relation, cursor, limit, recommendation, exclude_relation
        )

    @app.post("/v1/recommendations/run", status_code=202)
    async def recommend_run(request: RecommendRun, client=Depends(admin)):
        """Start a background run: the model advises on candidates without current advice.

        Advice never changes a status; the human decision stays with /review.
        """
        return service.recommend_start(request.limit, client["id"])

    @app.get("/v1/recommendations/status")
    def recommend_status(client=Depends(read)):
        return {**service.recommend_state, "enabled": bool(service.recommender)}

    @app.get("/v1/recommendations/summary")
    def recommend_summary(client=Depends(read)):
        return service.recommendation_summary()

    @app.get("/v1/candidates/{kind}/{item_id}")
    def candidate(kind: Literal["node", "link"], item_id: str, client=Depends(read)):
        return service.candidate(kind, item_id)

    @app.get("/v1/settings")
    def settings_view(client=Depends(admin)):
        """Effective provider configuration. API keys are never returned, only whether they are set."""
        return service.settings_view()

    @app.put("/v1/settings/llm")
    async def configure_llm(request: LLMSettingsUpdate, client=Depends(admin)):
        return await service.configure(request.model_dump(exclude_none=True), client["id"])

    @app.post("/v1/settings/llm/test")
    async def test_llm(request: ProviderTest, client=Depends(admin)):
        return await service.test_provider(request.target, client["id"])

    @app.get("/v1/conversations")
    def conversations(
        cursor: str | None = None,
        limit: int = URLQuery(default=25, ge=1, le=100),
        q: str | None = URLQuery(default=None, max_length=200),
        source: str | None = URLQuery(default=None, max_length=80),
        sort: str = URLQuery(default="activity", pattern="^(activity|added)$"),
        client=Depends(read),
    ):
        """Live conversations with title, themes and preview; filter by text/source, sort by activity or by when added."""
        return service.conversations(cursor, limit, q, source, sort)

    @app.get("/v1/conversations/{source_system}/{conversation_id:path}")
    def conversation(source_system: str, conversation_id: str, client=Depends(read)):
        try:
            return service.conversation(source_system, conversation_id)
        except KeyError:
            raise HTTPException(404, "conversation not found") from None

    @app.post("/v1/conversations/{source_system}/{conversation_id:path}/reprocess", status_code=202)
    def reprocess_conversation(source_system: str, conversation_id: str, client=Depends(admin)):
        try:
            return service.reprocess_conversation(source_system, conversation_id, client["id"])
        except KeyError:
            raise HTTPException(404, "conversation not found") from None
        except RuntimeError as error:
            raise HTTPException(409, str(error)) from None

    @app.delete("/v1/conversations/{source_system}/{conversation_id:path}")
    async def erase_conversation(
        source_system: str,
        conversation_id: str,
        client=Depends(admin),
        correlation_id=Depends(correlation),
    ):
        try:
            count = await service.erase_conversation(
                source_system, conversation_id, client["id"], correlation_id
            )
        except KeyError:
            raise HTTPException(404, "conversation not found") from None
        except Exception:
            raise HTTPException(
                503, "deletion incomplete; retry before considering the conversation erased"
            ) from None
        return {
            "status": "deleted_from_live_stores",
            "messages": count,
            "backups": "follow retention runbook",
        }

    @app.get("/v1/events")
    def events(
        type: list[str] = URLQuery(default=[]),
        from_: datetime | None = URLQuery(default=None, alias="from"),
        to: datetime | None = None,
        subject_kind: Literal["node", "link", "source", "memory_scope"] | None = None,
        subject_id: str | None = None,
        cursor: int | None = URLQuery(default=None, ge=0),
        limit: int = URLQuery(default=50, ge=1, le=200),
        order: Literal["asc", "desc"] = "asc",
        expand: Literal["subject"] | None = None,
        client=Depends(read),
    ):
        """Public event contract v1; see docs/EVENTS.md."""
        from .events import EVENT_TYPES

        if bad := [t for t in type if t not in EVENT_TYPES]:
            raise HTTPException(422, f"unknown event type: {bad[0]}")
        for stamp in (from_, to):
            if stamp is not None and stamp.tzinfo is None:
                raise HTTPException(422, "timestamps require a timezone")
        if bool(subject_kind) != bool(subject_id):
            raise HTTPException(422, "subject_kind and subject_id go together")
        # Stored times are rounded to microseconds; round the bounds identically so a recorded_at
        # taken from a response always compares equal when sent back as `from`/`to`.
        since = round(from_.astimezone(timezone.utc).timestamp(), 6) if from_ else None
        until = round(to.astimezone(timezone.utc).timestamp(), 6) if to else None
        page, more = service.journal.events(
            tuple(type),
            since,
            until,
            f"{subject_kind}:{subject_id}" if subject_kind else None,
            cursor,
            limit,
            order,
        )
        if expand == "subject":
            for item in page:
                item["subject_view"] = service.subject_view(item["subject"])
        return {
            "schema_version": 1,
            "events": page,
            "has_more": more,
            "next_cursor": str(page[-1]["sequence"]) if page else (str(cursor) if cursor else None),
            "order": order,
        }

    @app.get("/v1/links")
    def links(
        status: str | None = URLQuery(default=None, pattern="^(candidate|confirmed|rejected)$"),
        relation: str | None = URLQuery(default=None),
        limit: int = URLQuery(default=200, ge=1, le=2000),
        client=Depends(read),
    ):
        """Edges with endpoint summaries and source quotes; proposals are ranked by score."""
        nodes = service.state["nodes"]
        rows = []
        for edge in service.state["edges"].values():
            if status and edge["status"] != status or relation and edge["relation"] != relation:
                continue
            if edge["source_id"] not in nodes or edge["target_id"] not in nodes:
                continue
            ends = {
                role: {
                    k: nodes[edge[role + "_id"]][k]
                    for k in ("id", "kind", "label", "summary", "status")
                }
                for role in ("source", "target")
            }
            rows.append({**edge, "source": ends["source"], "target": ends["target"]})
        rows.sort(key=lambda r: (-r.get("proposal", {}).get("score", 0), r["id"]))
        return {"links": rows[:limit], "total": len(rows)}

    @app.post("/v1/maintenance/propose")
    async def propose_links(client=Depends(admin)):
        try:
            return await service.propose_links(client["id"])
        except Exception:
            raise HTTPException(503, "proposal generation failed; nothing was changed") from None

    @app.get("/v1/jobs")
    def jobs(client=Depends(read)):
        return {"jobs": service.journal.jobs()}

    @app.post("/v1/jobs/{episode_id}/retry")
    def retry(episode_id: str, client=Depends(admin)):
        if not service.journal.retry(episode_id, client["id"]):
            raise HTTPException(409, "only failed jobs can be retried")
        return {"status": "pending"}

    @app.post("/v1/maintenance/consolidate")
    async def consolidation(client=Depends(admin)):
        return await service.consolidate(client["id"])

    @app.delete("/v1/episodes/{episode_id}")
    async def erase(episode_id: str, client=Depends(admin), correlation_id=Depends(correlation)):
        try:
            await service.erase(episode_id, client["id"], correlation_id)
        except KeyError:
            raise HTTPException(404, "source not found") from None
        except Exception:
            raise HTTPException(
                503, "deletion incomplete; retry before considering source erased"
            ) from None
        return {"status": "deleted_from_live_stores", "backups": "follow retention runbook"}

    @app.get("/v1/export")
    async def export(client=Depends(admin)):
        async with service.lock:
            with service.journal.db() as db:
                import json

                episodes = [
                    {"episode_id": row["id"], **json.loads(row["payload"])}
                    for row in db.execute("SELECT * FROM episodes WHERE deleted=0 ORDER BY id")
                ]
            service.journal.audit(client["id"], "export", settings.scope)
            return {
                "schema_version": 1,
                "scope": settings.scope,
                "episodes": episodes,
                "active_graph": {
                    **service.state,
                    "nodes": {k: public_node(v) for k, v in service.state["nodes"].items()},
                },
            }

    return app
