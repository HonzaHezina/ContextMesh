import asyncio

import pytest

from active_memory.providers import GraphitiAdapter
from active_memory.settings import Settings


def test_explicit_model_authorization_required():
    with pytest.raises(ValueError, match="ALLOW_MODEL_CALLS"):
        Settings(_env_file=None, extraction_mode="llm", model_api_key="fake-key")


def test_graphiti_adapter_constructs_against_pinned_sdk(monkeypatch):
    pytest.importorskip("graphiti_core")
    monkeypatch.setenv("GRAPHITI_TELEMETRY_ENABLED", "false")
    settings = Settings(
        _env_file=None,
        backend="neo4j",
        graphiti_enabled=True,
        allow_model_calls=True,
        neo4j_password="fake-local-password",
        model_api_key="fake-model-key",
        embedding_api_key="fake-embedding-key",
    )
    adapter = GraphitiAdapter(settings)
    assert adapter.client.driver is not None
    from graphiti_core.helpers import validate_group_id

    assert validate_group_id(adapter.group_id)
    asyncio.run(adapter.close())


def test_graphiti_creates_episode_before_uuid_update(monkeypatch):
    pytest.importorskip("graphiti_core")
    from unittest.mock import AsyncMock

    from conftest import message
    from graphiti_core.errors import NodeNotFoundError
    from graphiti_core.nodes import EpisodicNode

    from active_memory.models import Message

    settings = Settings(
        _env_file=None,
        backend="neo4j",
        graphiti_enabled=True,
        allow_model_calls=True,
        neo4j_password="fake-password",
        model_api_key="fake-key",
        embedding_api_key="fake-key",
    )
    adapter = GraphitiAdapter(settings)
    source_id = "cf732712-4ab8-4f19-9ef0-654bed311534"
    monkeypatch.setattr(
        EpisodicNode, "get_by_uuid", AsyncMock(side_effect=NodeNotFoundError(source_id))
    )
    saved = AsyncMock()
    monkeypatch.setattr(EpisodicNode, "save", saved)
    projected = AsyncMock()
    monkeypatch.setattr(adapter.client, "add_episode", projected)
    asyncio.run(adapter.add(source_id, Message.model_validate(message())))
    saved.assert_awaited_once()
    assert projected.call_args.kwargs["uuid"] == source_id
    assert projected.call_args.kwargs["group_id"] == adapter.group_id
    asyncio.run(adapter.close())


@pytest.mark.parametrize(
    "quote,valid", [("Chci vlastnit svoji AI paměť", True), ("Tohle se nestalo", False)]
)
def test_llm_extraction_requires_supported_quotes(monkeypatch, quote, valid):
    import httpx
    from conftest import message

    from active_memory.models import Message
    from active_memory.providers import LLMExtractor

    result = {
        "items": [
            {"kind": "Goal", "label": "Vlastní paměť", "summary": "Vlastní paměť", "quote": quote}
        ]
    }

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, **kwargs):
            import json

            return httpx.Response(
                200,
                request=httpx.Request("POST", url),
                json={
                    "choices": [{"message": {"content": json.dumps(result)}}],
                    "usage": {"prompt_tokens": 11, "completion_tokens": 7},
                },
            )

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    settings = Settings(
        _env_file=None, extraction_mode="llm", allow_model_calls=True, model_api_key="fake-key"
    )
    extractor = LLMExtractor(settings)
    coro = extractor.extract(Message.model_validate(message()), [])
    if valid:
        assert asyncio.run(coro).items[0].quote == quote
        assert extractor.usage == {"calls": 1, "prompt_tokens": 11, "completion_tokens": 7}
    else:
        with pytest.raises(ValueError, match="unsupported evidence quote"):
            asyncio.run(coro)


def _fake_http(monkeypatch, handler):
    import httpx

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, **kwargs):
            return httpx.Response(
                200, request=httpx.Request("POST", url), json=handler(url, kwargs["json"])
            )

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)


def test_embeddings_client_batches_orders_and_counts_usage(monkeypatch):
    from active_memory.providers import OpenAIEmbeddings

    calls = []

    def handler(url, body):
        calls.append((url, len(body["input"])))
        data = [{"index": i, "embedding": [float(i), 1.0]} for i in range(len(body["input"]))]
        return {"data": data[::-1], "usage": {"total_tokens": 5}}

    _fake_http(monkeypatch, handler)
    settings = Settings(
        _env_file=None,
        similarity_mode="embedding",
        allow_model_calls=True,
        embedding_api_key="fake-key",
    )
    embedder = OpenAIEmbeddings(settings)
    vectors = asyncio.run(embedder.embed([f"t{i}" for i in range(70)]))
    assert [c[1] for c in calls] == [64, 6] and calls[0][0].endswith("/embeddings")
    assert vectors[3] == [3.0, 1.0] and len(vectors) == 70
    assert embedder.usage == {"calls": 2, "texts": 70, "tokens": 10}


@pytest.mark.parametrize(
    "answer,valid",
    [
        (
            {
                "relation": "CONTRADICTS",
                "reason": "opposite",
                "quote_a": "chci kontrolu",
                "quote_b": "vše automaticky",
            },
            True,
        ),
        (
            {
                "relation": "CONTRADICTS",
                "reason": "opposite",
                "quote_a": "invented",
                "quote_b": "vše automaticky",
            },
            False,
        ),
        ({"relation": "CONTRADICTS", "reason": "opposite"}, False),
        ({"relation": "UNRELATED", "reason": "nothing in common"}, True),
        ({"relation": "MERGE", "reason": "x"}, False),
    ],
)
def test_relation_judge_requires_quotes_from_shown_evidence(monkeypatch, answer, valid):
    import json

    from active_memory.providers import LLMRelationJudge

    seen = {}

    def handler(url, body):
        seen["prompt"] = body["messages"][0]["content"]
        return {
            "choices": [{"message": {"content": json.dumps(answer)}}],
            "usage": {"prompt_tokens": 9, "completion_tokens": 4},
        }

    _fake_http(monkeypatch, handler)
    settings = Settings(
        _env_file=None, judge_enabled=True, allow_model_calls=True, model_api_key="fake-key"
    )
    judge = LLMRelationJudge(settings)
    node = {"kind": "Thought", "label": "l", "summary": "s"}
    a = [
        {"quote": "Chci kontrolu".lower() + " nad vším", "occurred_at": "2026-01-01T00:00:00+00:00"}
    ]
    b = [{"quote": "chci vše automaticky", "occurred_at": "2026-01-02T00:00:00+00:00"}]
    coro = judge.judge(node, node, a, b)
    if valid:
        assert asyncio.run(coro)["relation"] == answer["relation"]
        assert judge.usage["prompt_tokens"] == 9
    else:
        with pytest.raises(ValueError):
            asyncio.run(coro)
    assert "untrusted" in seen["prompt"]


def test_similarity_settings_require_explicit_model_authorization():
    with pytest.raises(ValueError, match="ALLOW_MODEL_CALLS"):
        Settings(_env_file=None, similarity_mode="embedding", embedding_api_key="k")
    with pytest.raises(ValueError, match="API key is required for embeddings"):
        Settings(_env_file=None, similarity_mode="embedding", allow_model_calls=True)
    with pytest.raises(ValueError, match="model_api_key"):
        Settings(_env_file=None, judge_enabled=True, allow_model_calls=True)
    assert Settings(_env_file=None).effective_threshold == 0.5


def test_rate_limited_calls_are_retried_with_the_provider_delay(monkeypatch):
    import httpx

    from active_memory import providers

    waited = []

    async def fake_sleep(seconds):
        waited.append(seconds)

    monkeypatch.setattr(providers.asyncio, "sleep", fake_sleep)
    answers = iter([429, 503, 200])

    def handler(request):
        status = next(answers)
        headers = {"retry-after": "1"} if status == 429 else {}
        return httpx.Response(status, headers=headers, json={"ok": status == 200})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await providers.post_with_retry(client, "https://example.test/x", json={})

    response = asyncio.run(run())
    assert response.status_code == 200 and waited == [1.0, 5.0]


def test_rate_limit_that_never_clears_is_returned_after_the_last_try(monkeypatch):
    import httpx

    from active_memory import providers

    async def no_wait(seconds):
        return None

    monkeypatch.setattr(providers.asyncio, "sleep", no_wait)
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(429)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await providers.post_with_retry(client, "https://example.test/x")

    assert asyncio.run(run()).status_code == 429
    assert len(calls) == 1 + len(providers.RETRY_DELAYS)
