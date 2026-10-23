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


def test_conversation_title_comes_from_themes_else_from_the_first_message(client):
    put(client, "1", "chat-a")  # extraction cites the theme "Vlastnictví dat"
    put(
        client,
        "2",
        "chat-b",
        content="Jak poznám, kdy nechat rozhodnutí na systému?",
        extraction=None,
    )
    put(client, "3", "chat-c", content="x " * 100, extraction={"items": []})
    titles = {
        c["conversation_id"]: c["title"]
        for c in client.get("/v1/conversations").json()["conversations"]
    }
    assert titles["chat-a"] == "Vlastnictví dat"
    assert titles["chat-b"] == "Jak poznám, kdy nechat rozhodnutí na systému?"
    assert titles["chat-c"].endswith("…") and len(titles["chat-c"]) <= 71
    assert client.get("/v1/conversations/demo/chat-a").json()["title"] == "Vlastnictví dat"


def test_map_carries_readable_conversation_titles(client):
    put(client, "1", "chat-a")
    titles = client.get("/v1/map").json()["conversation_titles"]
    assert titles == {"demo/chat-a": "Vlastnictví dat"}


def test_conversation_counts_match_the_review_queue_and_leave_out_placement_links(client):
    put(client, "1", "chat-a")  # one Goal under one theme: two nodes and one ABOUT link
    detail = client.get("/v1/conversations/demo/chat-a").json()
    kinds = sorted(i["candidate_kind"] for i in detail["messages"][0]["derived"])
    assert kinds == ["Goal", "Theme"]  # the ABOUT link is placement, not a decision
    counted = client.get("/v1/conversations").json()["conversations"][0]["derived"]["candidate"]
    queue = client.get(
        "/v1/candidates",
        params={"kind": "all", "exclude_relation": "ABOUT", "status": "candidate"},
    ).json()
    assert counted == queue["total"] == 2


def test_conversations_search_filter_sort_and_overview_fields(client):
    put(
        client,
        "1",
        "garden",
        "2026-10-05T10:00:00Z",
        content="Plán zahrady na jaro.",
        extraction=None,
    )
    put(client, "2", "old", "2026-01-01T10:00:00Z", content="Něco o spánku.", extraction=None)
    client.post(  # same message text in another source system
        "/v1/episodes", json=message("3", "other", source_system="mail", extraction={"items": []})
    )
    drain(client)

    def ids(**params):
        rows = client.get("/v1/conversations", params=params).json()
        return [c["conversation_id"] for c in rows["conversations"]]

    assert set(ids()) == {"garden", "old", "other"}
    # "added" puts what was added last on top even though its messages are the oldest
    assert ids(sort="added")[0] == "other" and ids(sort="added")[1] == "old"
    assert ids(sort="activity")[-1] == "old"
    assert (
        ids(q="zahrad") == ["garden"] and ids(q="SPÁNKU") == ["old"] and ids(q="nic-takového") == []
    )
    assert ids(source="mail") == ["other"]
    first = client.get("/v1/conversations", params={"sort": "added", "limit": 2}).json()
    assert first["total"] == 3 and first["matching"] == 3 and first["has_more"]
    assert set(first["sources"]) == {"demo", "mail"}
    row = next(c for c in first["conversations"] if c["conversation_id"] == "old")
    assert row["preview"] == "Něco o spánku." and row["added_at"] and "themes" in row
    rest = client.get(
        "/v1/conversations", params={"sort": "added", "limit": 2, "cursor": first["next_cursor"]}
    ).json()
    assert [c["conversation_id"] for c in rest["conversations"]] == ["garden"]
    assert client.get("/v1/conversations", params={"sort": "bogus"}).status_code == 422
