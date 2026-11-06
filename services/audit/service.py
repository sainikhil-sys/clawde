"""Audit log: append-only record of security-relevant actions, visible to the user."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from storage.database.models import AuditEvent

#: Keys that must never be written into audit details, even by mistake.
_FORBIDDEN_DETAIL_KEYS = frozenset({"token", "csrf_token", "password", "secret", "api_key", "cookie"})


async def record(
    db: AsyncSession,
    action: str,
    *,
    actor: str = "user",
    target_type: str | None = None,
    target_id: str | None = None,
    details: dict[str, Any] | None = None,
    client_ip: str | None = None,
) -> AuditEvent:
    """Add an event to the current transaction. The caller commits."""
    details = details or {}
    leaked = _FORBIDDEN_DETAIL_KEYS.intersection(k.lower() for k in details)
    if leaked:
        raise ValueError(f"audit details must not contain secrets: {sorted(leaked)}")
    event = AuditEvent(
        action=action,
        actor=actor,
        target_type=target_type,
        target_id=target_id,
        details=details,
        client_ip=client_ip,
    )
    db.add(event)
    return event


async def list_events(db: AsyncSession, *, limit: int = 50, before_id: int | None = None) -> list[AuditEvent]:
    stmt = select(AuditEvent).order_by(AuditEvent.id.desc()).limit(limit)
    if before_id is not None:
        stmt = stmt.where(AuditEvent.id < before_id)
    return list((await db.scalars(stmt)).all())
