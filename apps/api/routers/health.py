from __future__ import annotations

from typing import Literal

import structlog
from fastapi import APIRouter
from pydantic import BaseModel

from storage.database.migrate import head_revision

from ..config import APP_VERSION
from ..deps import DatabaseDep

router = APIRouter(tags=["system"])
log = structlog.get_logger("clawde.api.health")


class DatabaseHealth(BaseModel):
    status: Literal["ok", "error"]
    revision: str | None
    head_revision: str | None


class Health(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    database: DatabaseHealth


@router.get("/health", response_model=Health)
async def health(database: DatabaseDep) -> Health:
    """Liveness and database readiness. Needs no session, so the UI can show connection status."""
    head = head_revision()
    try:
        await database.ping()
        revision = await database.current_revision()
        db = DatabaseHealth(
            status="ok" if revision == head else "error", revision=revision, head_revision=head
        )
    except Exception:
        log.exception("health.database_error")
        db = DatabaseHealth(status="error", revision=None, head_revision=head)
    return Health(status="ok" if db.status == "ok" else "degraded", version=APP_VERSION, database=db)
