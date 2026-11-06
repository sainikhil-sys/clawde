from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict

from models.registry import service as registry
from storage.database.models import ModelRecord

from ..deps import DbDep, GatewayDep
from ..security import SessionDep

router = APIRouter(prefix="/models", tags=["models"])


class ModelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider: str
    provider_ref: str
    display_name: str
    family: str | None
    parameter_size: str | None
    quantization: str | None
    format: str | None
    size_bytes: int | None
    context_length: int | None
    capabilities: list[str]
    available: bool
    chat: bool
    last_synced_at: datetime

    @classmethod
    def from_record(cls, rec: ModelRecord) -> ModelOut:
        return cls.model_validate(
            {
                **{c: getattr(rec, c) for c in cls.model_fields if c != "chat"},
                "chat": registry.is_chat_model(rec),
            }
        )


class ProviderStatusOut(BaseModel):
    name: str
    status: str
    message: str | None
    model_count: int


class ModelList(BaseModel):
    models: list[ModelOut]
    providers: list[ProviderStatusOut]


@router.get("", response_model=ModelList)
async def list_models(
    _: SessionDep,
    db: DbDep,
    gateway: GatewayDep,
    request: Request,
    include_unavailable: Annotated[bool, Query()] = False,
) -> ModelList:
    """Syncs the registry with every provider, then lists models. Cheap: one local request per provider."""
    statuses = await registry.sync(db, gateway)
    await db.commit()
    records = await registry.list_models(db, include_unavailable=include_unavailable)
    return ModelList(
        models=[ModelOut.from_record(r) for r in records],
        providers=[
            ProviderStatusOut(name=s.name, status=s.status, message=s.message, model_count=s.model_count)
            for s in statuses
        ],
    )
