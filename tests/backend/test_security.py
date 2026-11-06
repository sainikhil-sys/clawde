from __future__ import annotations

from datetime import timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import update

from api.config import Settings
from api.security import SESSION_COOKIE
from storage.database.base import utcnow
from storage.database.models import AppSession

from .conftest import BASE_URL, ORIGIN, csrf_headers, start_session


async def test_health_needs_no_session(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["database"]["status"] == "ok"
    assert body["database"]["revision"] == body["database"]["head_revision"]


async def test_session_cookie_flags(client: httpx.AsyncClient) -> None:
    resp = await client.post("/api/session", headers={"Origin": ORIGIN})
    assert resp.status_code == 201
    cookie = resp.headers["set-cookie"].lower()
    assert f"{SESSION_COOKIE}=" in cookie
    assert "httponly" in cookie
    assert "samesite=strict" in cookie
    assert "path=/" in cookie
    assert len(resp.json()["csrf_token"]) >= 32


async def test_raw_session_token_is_not_stored(client: httpx.AsyncClient, app: FastAPI) -> None:
    await start_session(client)
    raw = client.cookies[SESSION_COOKIE]
    async with app.state.database.sessionmaker() as s:
        assert await s.get(AppSession, raw) is None


@pytest.mark.parametrize("origin", [None, "http://evil.example", "http://127.0.0.1:3001", "null"])
async def test_session_creation_requires_allowed_origin(
    client: httpx.AsyncClient, origin: str | None
) -> None:
    headers = {"Origin": origin} if origin else {}
    resp = await client.post("/api/session", headers=headers)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "origin_not_allowed"
    assert SESSION_COOKIE not in client.cookies


@pytest.mark.parametrize("host", ["evil.example", "attacker.com:8000", "192.168.1.5"])
async def test_unknown_host_header_rejected(client: httpx.AsyncClient, host: str) -> None:
    """DNS rebinding: a hostile domain resolving to 127.0.0.1 sends its own Host header."""
    resp = await client.get("/api/health", headers={"Host": host})
    assert resp.status_code == 400


async def test_protected_routes_need_session(client: httpx.AsyncClient) -> None:
    assert (await client.get("/api/settings")).status_code == 401
    assert (await client.get("/api/audit")).status_code == 401
    assert (await client.get("/api/session")).status_code == 401


async def test_csrf_required_for_mutations(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    missing = await client.patch(
        "/api/settings", json={"network_access_enabled": True}, headers={"Origin": ORIGIN}
    )
    assert missing.status_code == 403
    assert missing.json()["detail"]["code"] == "csrf_failed"

    wrong = await client.patch(
        "/api/settings", json={"network_access_enabled": True}, headers=csrf_headers("x" * 43)
    )
    assert wrong.status_code == 403

    ok = await client.patch(
        "/api/settings", json={"network_access_enabled": True}, headers=csrf_headers(token)
    )
    assert ok.status_code == 200
    assert ok.json()["network_access_enabled"] is True


async def test_foreign_origin_blocked_even_with_valid_session(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    resp = await client.patch(
        "/api/settings",
        json={"network_access_enabled": True},
        headers={"Origin": "http://evil.example", "X-CSRF-Token": token},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "origin_not_allowed"


async def test_cors_only_for_web_ui(client: httpx.AsyncClient) -> None:
    allowed = await client.get("/api/health", headers={"Origin": ORIGIN})
    assert allowed.headers.get("access-control-allow-origin") == ORIGIN
    assert allowed.headers.get("access-control-allow-credentials") == "true"
    other = await client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in other.headers


async def test_get_session_returns_csrf_after_reload(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    resp = await client.get("/api/session")
    assert resp.status_code == 200
    assert resp.json()["csrf_token"] == token


async def test_expired_session_rejected(client: httpx.AsyncClient, app: FastAPI) -> None:
    await start_session(client)
    async with app.state.database.sessionmaker() as s:
        await s.execute(update(AppSession).values(expires_at=utcnow() - timedelta(seconds=1)))
        await s.commit()
    resp = await client.get("/api/settings")
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "session_expired"


async def test_logout_invalidates_session(client: httpx.AsyncClient) -> None:
    token = await start_session(client)
    old_cookie = client.cookies[SESSION_COOKIE]
    assert (await client.delete("/api/session", headers=csrf_headers(token))).status_code == 204
    # Replaying the old cookie must fail even if a client kept it.
    client.cookies.set(SESSION_COOKIE, old_cookie)
    assert (await client.get("/api/settings")).status_code == 401


async def test_body_size_limit(app: FastAPI, settings: Settings) -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=BASE_URL) as c:
        token = await start_session(c)
        big = "x" * (settings.max_request_bytes + 1)
        resp = await c.patch(
            "/api/settings",
            content=f'{{"default_model": "{big}"}}',
            headers={**csrf_headers(token), "Content-Type": "application/json"},
        )
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "body_too_large"


async def test_security_headers_present(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/health")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["referrer-policy"] == "no-referrer"
    assert "x-request-id" in resp.headers
    assert "server" not in {k.lower() for k in resp.headers}


def test_refuses_non_loopback_bind(tmp_path: object) -> None:
    with pytest.raises(ValueError, match="non-loopback"):
        Settings(host="0.0.0.0")  # noqa: S104
    assert Settings(host="0.0.0.0", allow_remote_bind=True).host == "0.0.0.0"  # noqa: S104
