from __future__ import annotations

from pathlib import Path

import httpx

from api.main import create_app

from .conftest import BASE_URL, csrf_headers, make_settings, start_session
from .fakes import FakeProvider


async def test_settings_defaults_and_validation(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    resp = await client.get("/api/settings")
    assert resp.json() == {
        "network_access_enabled": False,
        "default_model": None,
        "memory_enabled": True,
        "memory_auto_summarise": True,
        "artifacts_enabled": True,
    }

    unknown = await client.patch("/api/settings", json={"telemetry": True}, headers=csrf_headers(token))
    assert unknown.status_code == 422

    bad_type = await client.patch(
        "/api/settings", json={"network_access_enabled": "maybe"}, headers=csrf_headers(token)
    )
    assert bad_type.status_code == 422


async def test_settings_and_audit_persist_across_restart(data_dir: Path) -> None:
    """Acceptance: data survives an API restart (same data folder, new process state)."""
    settings = make_settings(data_dir)

    first = create_app(settings, providers=[FakeProvider()])
    async with (
        first.router.lifespan_context(first),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=first), base_url=BASE_URL) as c,
    ):
        token = await start_session(c)
        resp = await c.patch(
            "/api/settings", json={"default_model": "llama3.2:latest"}, headers=csrf_headers(token)
        )
        assert resp.status_code == 200

    second = create_app(settings, providers=[FakeProvider()])
    async with (
        second.router.lifespan_context(second),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=second), base_url=BASE_URL) as c,
    ):
        await start_session(c)
        assert (await c.get("/api/settings")).json()["default_model"] == "llama3.2:latest"
        actions = [e["action"] for e in (await c.get("/api/audit")).json()["events"]]
    assert actions == ["session.create", "settings.update", "session.create"]


async def test_audit_records_changes_without_secrets(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    await client.patch("/api/settings", json={"network_access_enabled": True}, headers=csrf_headers(token))
    # A no-op update is not audited.
    await client.patch("/api/settings", json={"network_access_enabled": True}, headers=csrf_headers(token))

    events = (await client.get("/api/audit")).json()["events"]
    assert [e["action"] for e in events] == ["settings.update", "session.create"]
    assert events[0]["details"] == {"changes": {"network_access_enabled": {"from": False, "to": True}}}
    raw = str(events)
    assert token not in raw
    assert client.cookies["clawde_session"] not in raw


async def test_audit_pagination(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    for i in range(5):
        await client.patch("/api/settings", json={"default_model": f"m{i}"}, headers=csrf_headers(token))
    page1 = (await client.get("/api/audit", params={"limit": 4})).json()
    assert len(page1["events"]) == 4
    assert page1["next_before_id"] is not None
    page2 = (await client.get("/api/audit", params={"limit": 4, "before_id": page1["next_before_id"]})).json()
    assert len(page2["events"]) == 2
    assert page2["next_before_id"] is None
    ids = [e["id"] for e in page1["events"] + page2["events"]]
    assert ids == sorted(ids, reverse=True)
