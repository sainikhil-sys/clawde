from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict

from services.audit import service as audit

from ..deps import DbDep
from ..security import SessionDep

router = APIRouter(prefix="/audit", tags=["audit"])


class AuditEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    actor: str
    action: str
    target_type: str | None
    target_id: str | None
    details: dict[str, Any]


class AuditPage(BaseModel):
    events: list[AuditEventOut]
    next_before_id: int | None


@router.get("", response_model=AuditPage)
async def list_audit_events(
    _: SessionDep,
    db: DbDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before_id: Annotated[int | None, Query(ge=1)] = None,
) -> AuditPage:
    events = await audit.list_events(db, limit=limit, before_id=before_id)
    next_before = events[-1].id if len(events) == limit else None
    return AuditPage(events=[AuditEventOut.model_validate(e) for e in events], next_before_id=next_before)
