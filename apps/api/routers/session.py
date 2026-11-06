from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel

from services.audit import service as audit

from ..deps import DbDep, SettingsDep
from ..security import (
    SESSION_COOKIE,
    CsrfSessionDep,
    SessionDep,
    client_ip,
    create_session,
    require_allowed_origin,
)

router = APIRouter(prefix="/session", tags=["session"])


class SessionInfo(BaseModel):
    csrf_token: str
    created_at: datetime
    expires_at: datetime


@router.post(
    "",
    response_model=SessionInfo,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_allowed_origin)],
)
async def start_session(
    request: Request, response: Response, db: DbDep, settings: SettingsDep
) -> SessionInfo:
    """Create a browser session. Only the web UI origin may call this."""
    ttl = timedelta(hours=settings.session_ttl_hours)
    token, session = await create_session(db, ttl, request.headers.get("user-agent"))
    await audit.record(db, "session.create", client_ip=client_ip(request))
    await db.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(ttl.total_seconds()),
        httponly=True,
        samesite="strict",
        secure=settings.cookie_secure,
        path="/",
    )
    return SessionInfo(
        csrf_token=session.csrf_token, created_at=session.created_at, expires_at=session.expires_at
    )


@router.get("", response_model=SessionInfo)
async def current_session(session: SessionDep) -> SessionInfo:
    """Lets the UI recover its CSRF token after a page reload. Cross-origin reads are blocked by CORS."""
    return SessionInfo(
        csrf_token=session.csrf_token, created_at=session.created_at, expires_at=session.expires_at
    )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def end_session(request: Request, response: Response, session: CsrfSessionDep, db: DbDep) -> None:
    await db.delete(session)  # same AsyncSession as the dependency (cached per request)
    await audit.record(db, "session.end", client_ip=client_ip(request))
    await db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="strict")
