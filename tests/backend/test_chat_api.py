from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update

from core.inference.provider import ProviderError
from services.conversation import service as conversations
from storage.database.models import Message

from .conftest import csrf_headers, start_session
from .fakes import FakeProvider, fake_model


def parse_sse(body: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return events


async def new_conversation(client: httpx.AsyncClient, token: str, **body: Any) -> str:
    resp = await client.post("/api/conversations", json=body, headers=csrf_headers(token))
    assert resp.status_code == 201, resp.text
    conv_id: str = resp.json()["id"]
    return conv_id


async def send(client: httpx.AsyncClient, token: str, conv_id: str, **body: Any) -> httpx.Response:
    body.setdefault("model_id", "fake:tiny")
    return await client.post(f"/api/conversations/{conv_id}/messages", json=body, headers=csrf_headers(token))


async def test_models_list_syncs_registry(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    await start_session(client)
    data = (await client.get("/api/models")).json()
    by_id = {m["id"]: m for m in data["models"]}
    assert set(by_id) == {"fake:tiny", "fake:embedder"}
    assert by_id["fake:tiny"]["chat"] is True
    assert by_id["fake:embedder"]["chat"] is False
    assert by_id["fake:tiny"]["context_length"] == 8192
    assert data["providers"] == [{"name": "fake", "status": "ok", "message": None, "model_count": 2}]

    # A model removed from the provider becomes unavailable but stays in the registry.
    provider.models = [fake_model("tiny")]
    data = (await client.get("/api/models")).json()
    assert [m["id"] for m in data["models"]] == ["fake:tiny"]
    everything = (await client.get("/api/models", params={"include_unavailable": True})).json()
    assert {m["id"]: m["available"] for m in everything["models"]} == {
        "fake:embedder": False,
        "fake:tiny": True,
    }


async def test_models_when_provider_down(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    await start_session(client)
    await client.get("/api/models")
    provider.available = False
    data = (await client.get("/api/models")).json()
    assert data["models"] == []
    assert data["providers"][0]["status"] == "unavailable"


async def test_full_turn_streams_and_persists(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    resp = await send(
        client, token, conv_id, content="Say hello to the world please", params={"temperature": 0.2}
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = parse_sse(resp.text)
    names = [e for e, _ in events]
    assert names == ["start", "token", "token", "token", "token", "done"]
    start = events[0][1]
    assert start["conversation"]["title"] == "Say hello to the world please"
    assert start["assistant_message"]["status"] == "streaming"
    assert "".join(d["text"] for e, d in events if e == "token") == "Hello, world!"
    done = events[-1][1]["message"]
    assert (done["status"], done["content"], done["completion_tokens"]) == ("complete", "Hello, world!", 4)
    assert provider.received_params[0].temperature == 0.2

    detail = (await client.get(f"/api/conversations/{conv_id}")).json()
    assert detail["model_id"] == "fake:tiny"
    assert [(m["role"], m["status"]) for m in detail["messages"]] == [
        ("user", "complete"),
        ("assistant", "complete"),
    ]
    assert detail["messages"][1]["parent_id"] == detail["messages"][0]["id"]

    listing = (await client.get("/api/conversations")).json()
    assert listing[0]["id"] == conv_id
    assert listing[0]["message_count"] == 2


async def test_second_turn_sends_history(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    await send(client, token, conv_id, content="first")
    await send(client, token, conv_id, content="second")
    sent = [m for m in provider.received[1] if m.role != "system"]
    assert [(m.role, m.content) for m in sent] == [
        ("user", "first"),
        ("assistant", "Hello, world!"),
        ("user", "second"),
    ]


async def test_context_length_capped_by_model(client: httpx.AsyncClient, provider: FakeProvider) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    await send(client, token, conv_id, content="hi", params={"context_length": 65536})
    assert provider.received_params[0].context_length == 8192


async def test_provider_error_is_reported_and_saved(
    client: httpx.AsyncClient, provider: FakeProvider
) -> None:
    provider.fail_with = ProviderError("runner crashed")
    provider.fail_after_tokens = 2
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    events = parse_sse((await send(client, token, conv_id, content="hi")).text)
    assert [e for e, _ in events] == ["start", "token", "token", "error"]
    assert events[-1][1]["code"] == "provider_error"
    msg = (await client.get(f"/api/conversations/{conv_id}")).json()["messages"][1]
    assert (msg["status"], msg["content"], msg["error"]) == ("error", "Hello, ", "runner crashed")


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"model_id": None}, "no_model_selected"),
        ({"model_id": "fake:missing"}, "model_unavailable"),
        ({"model_id": "nope:thing"}, "model_unavailable"),
        ({"model_id": "fake:embedder"}, "model_not_chat"),
    ],
)
async def test_model_validation(client: httpx.AsyncClient, body: dict[str, Any], code: str) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    resp = await client.post(
        f"/api/conversations/{conv_id}/messages", json={"content": "hi", **body}, headers=csrf_headers(token)
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == code


async def test_default_model_setting_is_used(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    await client.patch("/api/settings", json={"default_model": "fake:tiny"}, headers=csrf_headers(token))
    conv_id = await new_conversation(client, token)
    resp = await client.post(
        f"/api/conversations/{conv_id}/messages", json={"content": "hi"}, headers=csrf_headers(token)
    )
    assert parse_sse(resp.text)[-1][0] == "done"


async def test_message_validation_and_auth(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    assert (await send(client, token, conv_id, content="")).status_code == 422
    assert (await send(client, token, conv_id, content="x" * 100_001)).status_code in (413, 422)
    assert (await send(client, token, conv_id, content="hi", params={"temperature": 5})).status_code == 422
    assert (await send(client, token, "missing", content="hi")).status_code == 404
    no_csrf = await client.post(
        f"/api/conversations/{conv_id}/messages", json={"content": "hi", "model_id": "fake:tiny"}
    )
    assert no_csrf.status_code == 403


async def test_concurrent_generation_rejected(client: httpx.AsyncClient, app: FastAPI) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    app.state.active_generations.add(conv_id)
    resp = await send(client, token, conv_id, content="hi")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "generation_in_progress"


async def test_active_flag_cleared_after_turn(client: httpx.AsyncClient, app: FastAPI) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    await send(client, token, conv_id, content="hi")
    assert conv_id not in app.state.active_generations


async def test_startup_recovers_interrupted_replies(client: httpx.AsyncClient, app: FastAPI) -> None:
    token = await start_session(client)
    conv_id = await new_conversation(client, token)
    await send(client, token, conv_id, content="hi")
    async with app.state.database.sessionmaker() as s:
        await s.execute(update(Message).where(Message.role == "assistant").values(status="streaming"))
        await s.commit()
    assert await conversations.recover_interrupted(app.state.database.sessionmaker) == 1
    msg = (await client.get(f"/api/conversations/{conv_id}")).json()["messages"][1]
    assert msg["status"] == "cancelled"
