"""Rename, pin, archive, folders, delete, search, export, templates and JSON mode."""

from __future__ import annotations

import json

import httpx

from .conftest import csrf_headers, start_session
from .fakes import FakeProvider
from .test_chat_api import new_conversation, parse_sse, send


async def patch(client: httpx.AsyncClient, token: str, conv_id: str, **body: object) -> httpx.Response:
    return await client.patch(f"/api/conversations/{conv_id}", json=body, headers=csrf_headers(token))


async def test_rename_pin_archive(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    a = await new_conversation(client, token, title="Alpha")
    b = await new_conversation(client, token, title="Beta")

    assert (await patch(client, token, a, title="  Renamed  ")).json()["title"] == "Renamed"
    assert (await patch(client, token, a, title="")).status_code == 422

    await patch(client, token, a, pinned=True)
    listing = (await client.get("/api/conversations")).json()
    assert [c["id"] for c in listing] == [a, b]  # pinned first even though b is newer

    await patch(client, token, b, archived=True)
    assert [c["id"] for c in (await client.get("/api/conversations")).json()] == [a]
    archived = (await client.get("/api/conversations", params={"archived": True})).json()
    assert [c["id"] for c in archived] == [b]
    assert [c["id"] for c in (await client.get("/api/conversations", params={"pinned": True})).json()] == [a]


async def test_folders(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    conv = await new_conversation(client, token)
    folder = (await client.post("/api/folders", json={"name": "Work"}, headers=csrf_headers(token))).json()

    assert (await patch(client, token, conv, folder_id=folder["id"])).json()["folder_id"] == folder["id"]
    assert (await patch(client, token, conv, folder_id="nope")).status_code == 404
    in_folder = (await client.get("/api/conversations", params={"folder_id": folder["id"]})).json()
    assert [c["id"] for c in in_folder] == [conv]
    assert (await client.get("/api/folders")).json()[0]["conversation_count"] == 1

    renamed = await client.patch(
        f"/api/folders/{folder['id']}", json={"name": "Projects"}, headers=csrf_headers(token)
    )
    assert renamed.json()["name"] == "Projects"

    # Deleting a folder keeps its conversations (unfiled).
    assert (
        await client.delete(f"/api/folders/{folder['id']}", headers=csrf_headers(token))
    ).status_code == 204
    detail = (await client.get(f"/api/conversations/{conv}")).json()
    assert detail["folder_id"] is None
    # Explicit null also unfiles.
    folder2 = (await client.post("/api/folders", json={"name": "Tmp"}, headers=csrf_headers(token))).json()
    await patch(client, token, conv, folder_id=folder2["id"])
    assert (await patch(client, token, conv, folder_id=None)).json()["folder_id"] is None


async def test_delete_removes_messages_and_is_audited(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    conv = await new_conversation(client, token)
    await send(client, token, conv, content="secret plans")
    assert (await client.delete(f"/api/conversations/{conv}", headers=csrf_headers(token))).status_code == 204
    assert (await client.get(f"/api/conversations/{conv}")).status_code == 404
    assert (await client.get("/api/conversations/search", params={"q": "secret"})).json() == []
    event = (await client.get("/api/audit")).json()["events"][0]
    assert (event["action"], event["target_id"], event["details"]) == (
        "conversation.delete",
        conv,
        {"messages": 2, "files": 0},
    )
    assert "secret" not in json.dumps(event)


async def test_search_titles_and_messages(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    a = await new_conversation(client, token, title="Rust borrow checker")
    b = await new_conversation(client, token)
    provider.reply = [
        "Paris is the capital of France, known for the Eiffel Tower and 100% butter croissants."
    ]
    await send(client, token, b, content="What is the capital of France?")

    by_title = (await client.get("/api/conversations/search", params={"q": "BORROW"})).json()
    assert [(h["conversation"]["id"], h["match"]) for h in by_title] == [(a, "title")]

    by_body = (await client.get("/api/conversations/search", params={"q": "eiffel"})).json()
    assert [(h["conversation"]["id"], h["match"]) for h in by_body] == [(b, "message")]
    assert "Eiffel Tower" in by_body[0]["snippet"]

    # LIKE wildcards in the query are matched literally.
    assert len((await client.get("/api/conversations/search", params={"q": "100%"})).json()) == 1
    assert (await client.get("/api/conversations/search", params={"q": "1_0"})).json() == []
    assert (await client.get("/api/conversations/search", params={"q": ""})).status_code == 422


async def test_export_markdown_and_json(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    conv = await new_conversation(client, token)
    await send(client, token, conv, content="Explain *recursion*")

    md = await client.get(f"/api/conversations/{conv}/export", headers={"Origin": "http://127.0.0.1:3000"})
    # The web UI reads the filename cross-origin, so CORS must expose the header.
    assert "content-disposition" in md.headers["access-control-expose-headers"].lower()
    assert md.headers["content-type"].startswith("text/markdown")
    assert 'attachment; filename="explain-recursion-' in md.headers["content-disposition"]
    assert "# Explain *recursion*" in md.text
    assert "## You" in md.text and "## Assistant" in md.text and "Hello, world!" in md.text

    js = await client.get(f"/api/conversations/{conv}/export", params={"format": "json"})
    doc = js.json()
    assert doc["format"] == "clawde.conversation.v1"
    assert len(doc["messages"]) == 2 and doc["active_path"] == [m["id"] for m in doc["messages"]]
    assert (
        await client.get(f"/api/conversations/{conv}/export", params={"format": "pdf"})
    ).status_code == 422


async def test_templates_crud(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    created = (
        await client.post(
            "/api/templates", json={"name": "Review", "content": "Review this code:"}, headers=h
        )
    ).json()
    await client.post("/api/templates", json={"name": "apology", "content": "Write an apology"}, headers=h)
    assert [t["name"] for t in (await client.get("/api/templates")).json()] == ["apology", "Review"]
    updated = await client.patch(
        f"/api/templates/{created['id']}", json={"content": "Review carefully:"}, headers=h
    )
    assert updated.json()["content"] == "Review carefully:"
    assert (
        await client.post("/api/templates", json={"name": "", "content": "x"}, headers=h)
    ).status_code == 422
    assert (await client.delete(f"/api/templates/{created['id']}", headers=h)).status_code == 204
    assert (await client.delete(f"/api/templates/{created['id']}", headers=h)).status_code == 404


async def test_json_mode(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    conv = await new_conversation(client, token)
    provider.reply = ['{"name": ', '"Ada"}']
    events = parse_sse(
        (await send(client, token, conv, content="json please", params={"response_format": "json"})).text
    )
    assert provider.received_params[-1].response_format == "json"
    assert events[-1][1]["json_valid"] is True

    provider.reply = ["not json"]
    events = parse_sse(
        (await send(client, token, conv, content="again", params={"response_format": "json"})).text
    )
    assert events[-1][1]["json_valid"] is False
