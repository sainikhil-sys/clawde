"""Projects: CRUD, knowledge files, instructions and knowledge in chats, isolation, search, export, delete."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest

from api.config import Settings
from storage.vector_index.faiss_index import VectorIndex

from .conftest import csrf_headers, start_session
from .fakes import FakeProvider, fake_model
from .test_attachments import wait_done
from .test_chat_api import parse_sse, send


async def create_project(client: httpx.AsyncClient, token: str, **body: Any) -> dict[str, Any]:
    body.setdefault("name", "Research")
    resp = await client.post("/api/projects", json=body, headers=csrf_headers(token))
    assert resp.status_code == 201, resp.text
    data: dict[str, Any] = resp.json()
    return data


async def add_knowledge(
    client: httpx.AsyncClient, token: str, project_id: str, name: str, data: bytes
) -> dict[str, Any]:
    resp = await client.post(
        f"/api/projects/{project_id}/knowledge", files={"file": (name, data)}, headers=csrf_headers(token)
    )
    assert resp.status_code == 201, resp.text
    done = await wait_done(client, resp.json()["id"])
    assert done["status"] == "ready", done
    return done


async def project_chat(client: httpx.AsyncClient, token: str, project_id: str) -> str:
    resp = await client.post(
        "/api/conversations", json={"project_id": project_id}, headers=csrf_headers(token)
    )
    assert resp.status_code == 201, resp.text
    conv_id: str = resp.json()["id"]
    return conv_id


def system_text(provider: FakeProvider) -> str:
    return "\n".join(m.content for m in provider.received[-1] if m.role == "system")


async def test_crud_and_counts(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    p = await create_project(
        client, token, name="  Thesis  ", description="PhD work", instructions="Be rigorous."
    )
    assert (p["name"], p["description"], p["instructions"]) == ("Thesis", "PhD work", "Be rigorous.")
    await project_chat(client, token, p["id"])
    await add_knowledge(client, token, p["id"], "outline.md", b"# Outline")

    listing = (await client.get("/api/projects")).json()
    assert [(x["name"], x["conversation_count"], x["knowledge_count"]) for x in listing] == [("Thesis", 1, 1)]

    updated = await client.patch(
        f"/api/projects/{p['id']}", json={"instructions": "Cite sources."}, headers=csrf_headers(token)
    )
    assert updated.json()["instructions"] == "Cite sources."
    assert (
        await client.patch(f"/api/projects/{p['id']}", json={"name": ""}, headers=csrf_headers(token))
    ).status_code == 422

    archived = await client.patch(
        f"/api/projects/{p['id']}", json={"archived": True}, headers=csrf_headers(token)
    )
    assert archived.json()["archived_at"] is not None
    assert (await client.get("/api/projects")).json() == []
    assert len((await client.get("/api/projects", params={"archived": True})).json()) == 1
    blocked = await client.post(
        "/api/conversations", json={"project_id": p["id"]}, headers=csrf_headers(token)
    )
    assert blocked.status_code == 409
    assert (
        await client.post("/api/conversations", json={"project_id": "missing"}, headers=csrf_headers(token))
    ).status_code == 404


async def test_project_chat_uses_instructions_and_knowledge(
    client: httpx.AsyncClient, provider: FakeProvider
) -> None:
    token = await start_session(client)
    p = await create_project(client, token, name="Ops", instructions="Always answer in French.")
    await add_knowledge(
        client,
        token,
        p["id"],
        "runbook.txt",
        b"To restart the billing service run: systemctl restart billing.",
    )
    conv = await project_chat(client, token, p["id"])
    events = parse_sse((await send(client, token, conv, content="How do I restart billing?")).text)

    # Exactly one system message, so behaviour doesn't depend on how a backend's template treats extras.
    systems = [m for m in provider.received[-1] if m.role == "system"]
    assert len(systems) == 1 and provider.received[-1][0].role == "system"
    system = system_text(provider)
    assert system.index("Always answer in French.") < system.index("systemctl restart billing")
    assert 'Instructions from the user for every conversation in the project "Ops"' in system
    assert "Always answer in French." in system
    assert "systemctl restart billing" in system
    assert 'source="project knowledge"' in system
    files = events[0][1]["documents"]["files"]
    assert files == [
        {
            "id": files[0]["id"],
            "filename": "runbook.txt",
            "origin": "project",
            "excerpts": None,
            "total_excerpts": None,
            "used": True,
            "image_visible": None,
        }
    ]

    # Chats outside the project see none of it.
    other = (await client.post("/api/conversations", json={}, headers=csrf_headers(token))).json()["id"]
    await send(client, token, other, content="How do I restart billing?")
    assert "billing" not in system_text(provider).lower() and "Instructions from the user" not in system_text(
        provider
    )


async def test_projects_are_isolated(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    """Acceptance: retrieval in project A never returns project B's text."""
    token = await start_session(client)
    a = await create_project(client, token, name="Alpha")
    b = await create_project(client, token, name="Bravo")
    filler = "\n\n".join(f"Paragraph {i} about routine maintenance schedules." for i in range(300))
    await add_knowledge(
        client, token, a["id"], "a.txt", f"{filler}\n\nThe vault code is ALPHA-1111.\n\n{filler}".encode()
    )
    await add_knowledge(
        client, token, b["id"], "b.txt", f"{filler}\n\nThe vault code is BRAVO-2222.\n\n{filler}".encode()
    )

    small = {"context_length": 2048, "max_tokens": 256}
    conv_a = await project_chat(client, token, a["id"])
    events = parse_sse(
        (await send(client, token, conv_a, content="What is the vault code?", params=small)).text
    )
    assert events[0][1]["documents"]["mode"] == "excerpts"
    assert "ALPHA-1111" in system_text(provider)
    assert "BRAVO-2222" not in system_text(provider)

    conv_b = await project_chat(client, token, b["id"])
    await send(client, token, conv_b, content="What is the vault code?", params=small)
    assert "BRAVO-2222" in system_text(provider)
    assert "ALPHA-1111" not in system_text(provider)

    # Search is scoped too.
    hits = (await client.get(f"/api/projects/{a['id']}/search", params={"q": "vault code"})).json()
    assert all("BRAVO" not in h["snippet"] for h in hits)
    assert any(h["kind"] == "knowledge" and "ALPHA-1111" in h["snippet"] for h in hits)


async def test_isolation_with_vector_indexes(
    client: httpx.AsyncClient, provider: FakeProvider, settings: Settings
) -> None:
    provider.models.append(fake_model("embed", capabilities=("embedding",)))
    token = await start_session(client)
    await client.get("/api/models")
    a = await create_project(client, token, name="Ocean")
    b = await create_project(client, token, name="Mountain")
    filler = "\n\n".join(f"Note {i}: finance figures and quarterly totals." for i in range(200))
    await add_knowledge(
        client, token, a["id"], "a.txt", f"{filler}\n\nThe ocean tide table is TIDE-77.".encode()
    )
    await add_knowledge(
        client, token, b["id"], "b.txt", f"{filler}\n\nThe mountain pass code is PASS-88.".encode()
    )

    small = {"context_length": 1024, "max_tokens": 256}
    conv_a = await project_chat(client, token, a["id"])
    events = parse_sse(
        (await send(client, token, conv_a, content="Tell me about the ocean", params=small)).text
    )
    assert events[0][1]["documents"]["semantic"] is True
    assert "TIDE-77" in system_text(provider) and "PASS-88" not in system_text(provider)

    # Each project has its own index file built only from its own chunks.
    idx_a = VectorIndex(settings.indexes_dir, f"project-{a['id']}")
    idx_b = VectorIndex(settings.indexes_dir, f"project-{b['id']}")
    assert idx_a.index_path.is_file() and not idx_b.index_path.is_file()  # B not queried yet
    conv_b = await project_chat(client, token, b["id"])
    await send(client, token, conv_b, content="Tell me about the mountain", params=small)
    assert idx_b.index_path.is_file()
    assert "PASS-88" in system_text(provider) and "TIDE-77" not in system_text(provider)


async def test_removing_knowledge_updates_retrieval(
    client: httpx.AsyncClient, provider: FakeProvider
) -> None:
    token = await start_session(client)
    p = await create_project(client, token)
    f = await add_knowledge(client, token, p["id"], "old.txt", b"The meeting room is Orchid.")
    conv = await project_chat(client, token, p["id"])
    await send(client, token, conv, content="Which meeting room?")
    assert "Orchid" in system_text(provider)
    assert (
        await client.delete(f"/api/attachments/{f['id']}", headers=csrf_headers(token))
    ).status_code == 204
    await send(client, token, conv, content="Which meeting room?")
    assert "Orchid" not in system_text(provider)
    assert (await client.get(f"/api/projects/{p['id']}/knowledge")).json() == []


async def test_project_conversation_listing(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    p = await create_project(client, token)
    inside = await project_chat(client, token, p["id"])
    await client.post("/api/conversations", json={}, headers=csrf_headers(token))
    listed = (await client.get("/api/conversations", params={"project_id": p["id"]})).json()
    assert [c["id"] for c in listed] == [inside]
    assert listed[0]["project_id"] == p["id"]


async def test_export_zip(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    p = await create_project(client, token, name="Book draft", instructions="Use British spelling.")
    await add_knowledge(client, token, p["id"], "chapter1.md", b"# Chapter 1\nIt was a dark night.")
    conv = await project_chat(client, token, p["id"])
    await send(client, token, conv, content="Summarise chapter 1")

    resp = await client.get(f"/api/projects/{p['id']}/export")
    assert resp.headers["content-type"] == "application/zip"
    assert 'filename="book-draft-' in resp.headers["content-disposition"]
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    names = set(zf.namelist())
    assert "project.json" in names
    assert "knowledge/chapter1.md" in names and "knowledge/extracted/chapter1.md.txt" in names
    assert any(n.startswith("conversations/") for n in names)
    meta = json.loads(zf.read("project.json"))
    assert meta["project"]["instructions"] == "Use British spelling."
    assert zf.read("knowledge/chapter1.md") == b"# Chapter 1\nIt was a dark night."


async def test_delete_removes_everything(
    client: httpx.AsyncClient, settings: Settings, provider: FakeProvider
) -> None:
    provider.models.append(fake_model("embed", capabilities=("embedding",)))
    token = await start_session(client)
    await client.get("/api/models")
    p = await create_project(client, token)
    k = await add_knowledge(client, token, p["id"], "k.txt", b"knowledge text about the ocean")
    conv = await project_chat(client, token, p["id"])
    await send(client, token, conv, content="ocean?")
    index_file = settings.indexes_dir / f"project-{p['id']}.faiss"
    assert index_file.is_file() and (settings.uploads_dir / k["id"]).exists()

    assert (await client.delete(f"/api/projects/{p['id']}", headers=csrf_headers(token))).status_code == 204
    assert (await client.get(f"/api/projects/{p['id']}")).status_code == 404
    assert (await client.get(f"/api/conversations/{conv}")).status_code == 404
    assert not (settings.uploads_dir / k["id"]).exists()
    assert not index_file.exists()
    event = (await client.get("/api/audit")).json()["events"][0]
    assert (event["action"], event["details"]) == ("project.delete", {"conversations": 1, "files": 1})


# ---- FAISS index unit tests ----


def test_vector_index_build_search_persist(tmp_path: Path) -> None:
    idx = VectorIndex(tmp_path, "project-test")
    idx.build([10, 20, 30], [[1, 0, 0], [0, 1, 0], [0.9, 0.1, 0]], model="m", signature="s1")
    hits = idx.search([1, 0, 0], k=2)
    assert [h[0] for h in hits] == [10, 30]
    assert hits[0][1] == pytest.approx(1.0, abs=1e-5)

    reopened = VectorIndex(tmp_path, "project-test")
    meta = reopened.load()
    assert meta is not None and (meta.model, meta.dim, meta.signature, meta.count) == ("m", 3, "s1", 3)
    assert [h[0] for h in reopened.search([0, 1, 0], k=1)] == [20]
    with pytest.raises(ValueError):
        reopened.search([1, 0], k=1)


def test_vector_index_rejects_bad_scope_and_handles_corruption(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        VectorIndex(tmp_path, "../escape")
    idx = VectorIndex(tmp_path, "project-x")
    idx.build([1], [[1.0, 2.0]], model="m", signature="s")
    idx.index_path.write_bytes(b"garbage")
    assert VectorIndex(tmp_path, "project-x").load() is None
    idx.delete()
    assert not idx.index_path.exists() and not idx.meta_path.exists()
