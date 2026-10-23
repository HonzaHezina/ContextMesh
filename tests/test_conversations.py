"""Conversation views: read-only, live sources only, each message shows what it produced."""

from conftest import OWNER_KEY, READER_KEY, drain, message
from fastapi.testclient import TestClient

READER = {"Authorization": f"Bearer {READER_KEY}"}


def put(client, mid, chat, when="2026-10-01T10:00:00Z", **extra):
    response = client.post("/v1/episodes", json=message(mid, chat, occurred_at=when, **extra))
    assert response.status_code == 202, response.text
    drain(client)
    return response.json()["episode_id"]


def test_conversations_list_detail_and_derived_candidates(client):
    first = put(client, "1", "chat-a", "2026-10-01T10:00:00Z")
    put(client, "2", "chat-a", "2026-10-01T10:05:00Z", role="assistant", extraction={"items": []})
    put(
        client,
        "3",
        "chat-b",
        "2026-10-02T09:00:00Z",
        content="Jiná zpráva.",
        extraction={"items": []},
    )

    listing = client.get("/v1/conversations").json()
    assert [c["conversation_id"] for c in listing["conversations"]] == ["chat-b", "chat-a"]
    chat_a = listing["conversations"][1]
    assert chat_a["messages"] == 2 and chat_a["derived"]["candidate"] >= 1
    assert chat_a["first_at"] < chat_a["last_at"] and listing["total"] == 2

    detail = client.get("/v1/conversations/demo/chat-a").json()
    assert [m["message_id"] for m in detail["messages"]] == ["1", "2"]
    produced = detail["messages"][0]["derived"]
    assert detail["messages"][0]["episode_id"] == first and produced
    goal = next(i for i in produced if i["candidate_kind"] == "Goal")
    assert goal["status"] == "candidate" and goal["quotes"] == ["Chci vlastnit svoji AI paměť"]
    assert goal["subject"]["kind"] == "node"
    assert detail["messages"][1]["derived"] == []  # the assistant turn produced nothing


def test_conversations_page_by_cursor_and_unknown_is_404(client):
    for n in range(3):
        put(client, str(n), f"chat-{n}", f"2026-10-0{n + 1}T10:00:00Z", extraction={"items": []})
    first = client.get("/v1/conversations", params={"limit": 2}).json()
    assert len(first["conversations"]) == 2 and first["has_more"]
    rest = client.get(
        "/v1/conversations", params={"limit": 2, "cursor": first["next_cursor"]}
    ).json()
    seen = [c["conversation_id"] for c in first["conversations"] + rest["conversations"]]
    assert seen == ["chat-2", "chat-1", "chat-0"] and not rest["has_more"]
    assert client.get("/v1/conversations/demo/missing").status_code == 404
    assert client.get("/v1/conversations", params={"cursor": "x"}).status_code == 422


def test_conversations_need_read_and_vanish_with_the_source(app):
    with TestClient(app) as anonymous:
        assert anonymous.get("/v1/conversations").status_code == 401
        owner = {"Authorization": f"Bearer {OWNER_KEY}"}
        episode = put_as(anonymous, owner)
        assert anonymous.get("/v1/conversations", headers=READER).status_code == 200
        assert anonymous.delete(f"/v1/episodes/{episode}", headers=owner).status_code == 200
        assert anonymous.get("/v1/conversations", headers=READER).json()["total"] == 0
        gone = anonymous.get("/v1/conversations/demo/chat-a", headers=READER)
        assert gone.status_code == 404 and "paměť" not in gone.text


def put_as(client, headers):
    response = client.post("/v1/episodes", json=message("1", "chat-a"), headers=headers)
    drain(client)
    return response.json()["episode_id"]


def test_reprocess_needs_a_model_and_requeues_only_user_messages(client):
    # Pasted and imported messages carry no extraction of their own, so the model decides.
    put(client, "1", "chat-a", extraction=None)
    put(client, "2", "chat-a", "2026-10-01T10:05:00Z", role="assistant", extraction=None)
    url = "/v1/conversations/demo/chat-a/reprocess"
    assert client.post(url).status_code == 409  # no model configured: nothing new could be found

    class Fake:
        async def extract(self, message, themes):
            from active_memory.models import Extraction

            return Extraction.model_validate(
                {
                    "items": [
                        {
                            "kind": "Thought",
                            "label": "Nový nález",
                            "summary": "Model našel něco nového.",
                            "quote": message.content[:10],
                            "themes": ["Téma z modelu"],
                            "confidence": 0.7,
                        }
                    ]
                }
            )

    client.app.state.memory.extractor = Fake()
    answer = client.post(url)
    assert answer.status_code == 202 and answer.json() == {"queued": 1, "user_messages": 1}
    drain(client)
    detail = client.get("/v1/conversations/demo/chat-a").json()
    assert any(i["title"] == "Nový nález" for i in detail["messages"][0]["derived"])
    assert client.post("/v1/conversations/demo/missing/reprocess").status_code == 404
    reader = {"Authorization": f"Bearer {READER_KEY}"}
    assert client.post(url, headers=reader).status_code == 403


def test_delete_conversation_removes_all_its_messages_and_derived_items(client):
    put(client, "1", "chat-a")
    put(client, "2", "chat-a", "2026-10-01T10:05:00Z", role="assistant", extraction={"items": []})
    put(client, "3", "chat-b", "2026-10-02T09:00:00Z", extraction={"items": []})
    reader = {"Authorization": f"Bearer {READER_KEY}"}
    assert client.delete("/v1/conversations/demo/chat-a", headers=reader).status_code == 403
    answer = client.delete("/v1/conversations/demo/chat-a")
    assert answer.status_code == 200 and answer.json()["messages"] == 2
    assert client.get("/v1/conversations/demo/chat-a").status_code == 404
    assert [
        c["conversation_id"] for c in client.get("/v1/conversations").json()["conversations"]
    ] == ["chat-b"]
    assert client.delete("/v1/conversations/demo/chat-a").status_code == 404
    assert "Vlastní AI paměť" not in client.get("/v1/export").text
