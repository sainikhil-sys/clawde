"""Artifacts: parsing model replies, versions, editing, restore, download, deletion, settings."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from core.artifacts.parse import normalise_kind, parse_artifacts
from core.inference.provider import ProviderUnavailable
from services.artifacts import service as artifact_service

from .conftest import csrf_headers, start_session
from .fakes import FakeProvider
from .test_chat_api import new_conversation, parse_sse, send

PAGE = '<artifact identifier="hello-page" type="html" title="Hello page">\n<h1>Hello</h1>\n</artifact>'


async def reply_with(
    client: httpx.AsyncClient, provider: FakeProvider, token: str, conv: str, text: str
) -> dict[str, Any]:
    provider.reply = (text,)
    resp = await send(client, token, conv, content="make it")
    events = parse_sse(resp.text)
    assert events[-1][0] == "done", events
    done: dict[str, Any] = events[-1][1]
    return done


# ---- Parsing ----


def test_parse_blocks_and_lenient_types() -> None:
    text = (
        "Here you go.\n"
        '<artifact identifier="todo" type="application/vnd.ant.react" title="Todo &amp; list">\n'
        "```jsx\nexport default function App() { return <p>hi</p> }\n```\n"
        "</artifact>\n"
        "<artifact type='python' title='Fib'>def fib(n): ...</artifact>\n"
        '<artifact type="svg" title="Empty"></artifact>\n'
        '<artifact identifier="cut" type="html" title="Cut off"><p>never closed'
    )
    # While a reply is still being written, an unclosed block isn't taken.
    blocks = parse_artifacts(text, finished=False)
    assert [(b.identifier, b.kind, b.title, b.language) for b in blocks] == [
        ("todo", "react", "Todo & list", None),
        ("fib", "code", "Fib", "python"),
    ]
    # The Markdown fence the model added inside the block is removed.
    assert blocks[0].content == "export default function App() { return <p>hi</p> }"
    assert text[blocks[0].start : blocks[0].end].startswith("<artifact")
    assert normalise_kind("image/svg+xml") == ("svg", None)
    assert normalise_kind("TEXT/HTML") == ("html", None)
    assert normalise_kind("code", "rust") == ("code", "rust")
    assert parse_artifacts('<artifact title="My Page!" type="html">x</artifact>')[0].identifier == "my-page"


def test_missing_closing_tag_is_accepted_when_content_is_fenced() -> None:
    # Seen with llama3.2: the closing tag is forgotten but the content is a complete code fence.
    opening = '<artifact identifier="tea" type="mermaid" title="Tea">\n'
    text = opening + "```mermaid\ngraph LR\n  A-->B\n```\nThat is tea."
    [block] = parse_artifacts(text)
    assert (block.identifier, block.content) == ("tea", "graph LR\n  A-->B")
    assert text[block.end :] == "\nThat is tea."
    # A closing tag after another opening tag doesn't belong to the first block.
    two = (
        '<artifact title="A" type="html">```html\n<p>a</p>\n```\n'
        '<artifact title="B" type="html"><p>b</p></artifact>'
    )
    assert [(b.title, b.content) for b in parse_artifacts(two)] == [("A", "<p>a</p>"), ("B", "<p>b</p>")]


# ---- From model replies ----


async def test_reply_creates_artifact_and_updates_make_versions(
    client: httpx.AsyncClient, provider: FakeProvider
) -> None:
    token = await start_session(client)
    conv = await new_conversation(client, token)
    done = await reply_with(client, provider, token, conv, "A page:\n" + PAGE)
    [ref] = done["artifacts"]
    assert (ref["identifier"], ref["kind"], ref["title"], ref["version"]) == (
        "hello-page",
        "html",
        "Hello page",
        1,
    )

    art = (await client.get(f"/api/artifacts/{ref['id']}")).json()
    assert art["content"] == "<h1>Hello</h1>" and art["conversation_id"] == conv and art["version_count"] == 1

    # Same identifier again with new content: a new version of the same artifact.
    done2 = await reply_with(client, provider, token, conv, PAGE.replace("Hello</h1>", "Hello again</h1>"))
    assert done2["artifacts"] == [{**ref, "version": 2}]
    # Identical content: no empty version.
    done3 = await reply_with(client, provider, token, conv, PAGE.replace("Hello</h1>", "Hello again</h1>"))
    assert done3["artifacts"][0]["version"] == 2
    versions = (await client.get(f"/api/artifacts/{ref['id']}/versions")).json()
    assert [(v["version"], v["source"]) for v in versions] == [(1, "model"), (2, "model")]

    # Reloading the conversation shows which reply made which version.
    detail = (await client.get(f"/api/conversations/{conv}")).json()
    made = [m["artifacts"] for m in detail["messages"] if m["role"] == "assistant"]
    assert [[a["version"] for a in refs] for refs in made] == [[1], [2], []]

    # Another conversation with the same identifier gets its own artifact.
    other = await new_conversation(client, token)
    done4 = await reply_with(client, provider, token, other, PAGE)
    assert done4["artifacts"][0]["id"] != ref["id"]


async def test_artifact_instructions_are_sent_unless_turned_off(
    client: httpx.AsyncClient, provider: FakeProvider
) -> None:
    token = await start_session(client)
    conv = await new_conversation(client, token)
    await send(client, token, conv, content="hi")
    first = provider.received[-1][0]
    assert first.role == "system" and first.content.startswith("You can create artifacts")
    assert "cannot load anything from the internet" in first.content

    await client.patch("/api/settings", json={"artifacts_enabled": False}, headers=csrf_headers(token))
    await send(client, token, conv, content="hi again")
    assert all(m.role != "system" for m in provider.received[-1])


async def test_artifact_extraction_failure_keeps_the_reply(
    client: httpx.AsyncClient, provider: FakeProvider, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(*_: Any) -> Any:
        raise RuntimeError("bug")

    monkeypatch.setattr(artifact_service, "extract_from_message", boom)
    token = await start_session(client)
    conv = await new_conversation(client, token)
    done = await reply_with(client, provider, token, conv, PAGE)
    assert "artifacts" not in done
    assert done["message"]["content"] == PAGE and done["message"]["status"] == "complete"
    assert (await client.get("/api/artifacts")).json() == []


def test_unclosed_block_in_a_finished_reply() -> None:
    # Seen with llama3.2: no closing tag and no fence, but the reply finished normally.
    opening = '<artifact type="html" title="Greeting">'
    text = opening + "<!doctype html><html><h1>Hi</h1></html>\nThis page greets you."
    [block] = parse_artifacts(text)
    assert block.content == "<!doctype html><html><h1>Hi</h1></html>"  # trailing prose stays out
    [md] = parse_artifacts('<artifact type="markdown" title="Notes"># Notes\n- a')
    assert md.content == "# Notes\n- a"
    # It stops at the next opening tag.
    two = parse_artifacts(
        '<artifact type="markdown" title="A">a\n<artifact type="markdown" title="B">b</artifact>'
    )
    assert [(b.title, b.content) for b in two] == [("A", "a"), ("B", "b")]
    assert parse_artifacts('<artifact type="html" title="x"><p>unfinished', finished=False) == []


async def test_stopped_reply_makes_no_artifact(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    """A reply the user stopped (or that failed) isn't parsed: its last block may be cut off."""
    token = await start_session(client)
    conv = await new_conversation(client, token)
    provider.reply = ('<artifact type="html" title="x"><p>one', " two", " three")
    provider.fail_with = ProviderUnavailable("down")
    provider.fail_after_tokens = 2
    resp = await send(client, token, conv, content="make it")
    assert parse_sse(resp.text)[-1][0] == "error"
    assert (await client.get("/api/artifacts")).json() == []


# ---- User CRUD ----


async def test_create_edit_restore_download_delete(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    created = await client.post(
        "/api/artifacts",
        json={"kind": "mermaid", "title": "Flow / chart", "content": "graph TD; A-->B"},
        headers=h,
    )
    assert created.status_code == 201, created.text
    art = created.json()
    assert (art["identifier"], art["conversation_id"], art["current_version"]) == ("flow-chart", None, 1)

    saved = (
        await client.put(
            f"/api/artifacts/{art['id']}/content", json={"content": "graph TD; A-->C"}, headers=h
        )
    ).json()
    assert saved["changed"] is True and saved["artifact"]["current_version"] == 2
    same = (
        await client.put(
            f"/api/artifacts/{art['id']}/content", json={"content": "graph TD; A-->C"}, headers=h
        )
    ).json()
    assert same["changed"] is False and same["artifact"]["current_version"] == 2

    v1 = (await client.get(f"/api/artifacts/{art['id']}/versions/1")).json()
    assert v1["content"] == "graph TD; A-->B" and v1["source"] == "user"
    restored = (await client.post(f"/api/artifacts/{art['id']}/versions/1/restore", headers=h)).json()
    assert (
        restored["artifact"]["current_version"] == 3 and restored["artifact"]["content"] == "graph TD; A-->B"
    )
    versions = (await client.get(f"/api/artifacts/{art['id']}/versions")).json()
    assert [(v["version"], v["source"], v["note"]) for v in versions] == [
        (1, "user", ""),
        (2, "user", ""),
        (3, "restore", "Restored version 1"),
    ]
    assert (await client.post(f"/api/artifacts/{art['id']}/versions/9/restore", headers=h)).status_code == 404

    renamed = (await client.patch(f"/api/artifacts/{art['id']}", json={"title": "Flow"}, headers=h)).json()
    assert renamed["title"] == "Flow"

    dl = await client.get(f"/api/artifacts/{art['id']}/download", params={"version": 2})
    assert dl.status_code == 200 and dl.text == "graph TD; A-->C"
    assert dl.headers["content-type"] == "application/octet-stream"
    assert dl.headers["content-disposition"] == 'attachment; filename="Flow-v2.mmd"'
    assert "sandbox" in dl.headers["content-security-policy"]

    listed = (await client.get("/api/artifacts", params={"q": "flo"})).json()
    assert [(a["id"], a["version_count"]) for a in listed] == [(art["id"], 3)]

    assert (await client.delete(f"/api/artifacts/{art['id']}", headers=h)).status_code == 204
    assert (await client.get(f"/api/artifacts/{art['id']}")).status_code == 404
    events = (await client.get("/api/audit")).json()["events"]
    assert any(
        e["action"] == "artifact.delete" and e["details"] == {"kind": "mermaid", "versions": 3}
        for e in events
    )


async def test_validation_and_scope(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    h = csrf_headers(token)
    bad = [
        {"kind": "exe", "title": "x", "content": "x"},
        {"kind": "html", "title": "", "content": "x"},
        {"kind": "html", "title": "x", "content": ""},
        {"kind": "html", "title": "x", "content": "x" * 500_001},
    ]
    for body in bad:
        assert (await client.post("/api/artifacts", json=body, headers=h)).status_code == 422, body
    missing = {"kind": "html", "title": "x", "content": "x", "conversation_id": "0" * 32}
    assert (await client.post("/api/artifacts", json=missing, headers=h)).status_code == 404
    assert (
        await client.post("/api/artifacts", json={"kind": "html", "title": "x", "content": "x"})
    ).status_code == 403

    # "Open as artifact" from a code block files it under that message's conversation.
    conv = await new_conversation(client, token)
    start = parse_sse((await send(client, token, conv, content="hi")).text)[0][1]
    made = await client.post(
        "/api/artifacts",
        json={
            "kind": "code",
            "language": "python",
            "title": "Snippet",
            "content": "print(1)",
            "source_message_id": start["assistant_message"]["id"],
        },
        headers=h,
    )
    assert made.json()["conversation_id"] == conv
    dl = await client.get(f"/api/artifacts/{made.json()['id']}/download")
    assert dl.headers["content-disposition"].endswith('-v1.py"')

    # Deleting the conversation deletes its artifacts.
    assert (await client.delete(f"/api/conversations/{conv}", headers=h)).status_code == 204
    assert (await client.get(f"/api/artifacts/{made.json()['id']}")).status_code == 404
