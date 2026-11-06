"""Local single-user sessions, CSRF protection and request origin checks.

Threat model (see docs/02-architecture.md): the API listens on loopback only. The main risk is a malicious
web page in the user's browser calling it. Defences:
- Host header allowlist (TrustedHostMiddleware) blocks DNS rebinding.
- Origin allowlist for state-changing requests, and CORS limited to the web UI origin.
- Session cookie is HttpOnly + SameSite=Strict; only its SHA-256 hash is stored.
- Every state-changing request needs an X-CSRF-Token header matching the session.
Other local processes running as the same OS user are inside the trust boundary.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from storage.database.base import utcnow
from storage.database.models import AppSession

from .deps import get_db, get_settings_dep

SESSION_COOKIE = "clawde_session"
CSRF_HEADER = "X-CSRF-Token"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
#: Avoid a database write on every request just to bump last_seen_at.
_LAST_SEEN_RESOLUTION = timedelta(minutes=5)


def api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


async def create_session(db: AsyncSession, ttl: timedelta, user_agent: str | None) -> tuple[str, AppSession]:
    """Returns (raw cookie token, stored session). The raw token is never persisted."""
    now = utcnow()
    await db.execute(delete(AppSession).where(AppSession.expires_at <= now))
    token = secrets.token_urlsafe(32)
    session = AppSession(
        id=hash_token(token),
        csrf_token=secrets.token_urlsafe(32),
        created_at=now,
        last_seen_at=now,
        expires_at=now + ttl,
        user_agent=(user_agent or "")[:300] or None,
    )
    db.add(session)
    return token, session


async def require_session(request: Request, db: Annotated[AsyncSession, Depends(get_db)]) -> AppSession:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise api_error(
            status.HTTP_401_UNAUTHORIZED, "no_session", "No session. Create one with POST /api/session."
        )
    session = await db.get(AppSession, hash_token(token))
    now = utcnow()
    if session is None or session.expires_at <= now:
        raise api_error(status.HTTP_401_UNAUTHORIZED, "session_expired", "Session is invalid or has expired.")
    if now - session.last_seen_at > _LAST_SEEN_RESOLUTION:
        session.last_seen_at = now
        await db.commit()
    return session


async def require_csrf(
    request: Request, session: Annotated[AppSession, Depends(require_session)]
) -> AppSession:
    """Use on every state-changing route that needs an existing session."""
    if request.method in UNSAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not sent or not hmac.compare_digest(sent, session.csrf_token):
            raise api_error(status.HTTP_403_FORBIDDEN, "csrf_failed", "Missing or invalid CSRF token.")
    return session


def require_allowed_origin(request: Request) -> None:
    """Session creation has no prior secret, so it must come from the web UI origin explicitly."""
    settings = get_settings_dep(request)
    origin = request.headers.get("origin")
    if origin is None or origin not in settings.allowed_origins:
        raise api_error(status.HTTP_403_FORBIDDEN, "origin_not_allowed", "Request origin is not allowed.")


SessionDep = Annotated[AppSession, Depends(require_session)]
CsrfSessionDep = Annotated[AppSession, Depends(require_csrf)]
