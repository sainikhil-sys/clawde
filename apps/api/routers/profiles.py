from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from services.audit import service as audit
from storage.database.models import BehaviourProfile, Conversation, ModelRecord, Project

from ..deps import DbDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip

router = APIRouter(prefix="/profiles", tags=["profiles"])


class ProfileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    system_prompt: str = Field(default="", max_length=20_000)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    top_p: float | None = Field(default=None, gt=0.0, le=1.0)
    max_tokens: int | None = Field(default=None, ge=1, le=32_768)
    context_length: int | None = Field(default=None, ge=512, le=131_072)


class ProfileOut(ProfileIn):
    model_config = ConfigDict(from_attributes=True, extra="ignore")

    id: str
    created_at: datetime
    updated_at: datetime
    #: How many models, projects and conversations use it.
    used_by: dict[str, int] = {}


async def _usage(db: DbDep, profile_id: str) -> dict[str, int]:
    out = {}
    for label, table in (("models", ModelRecord), ("projects", Project), ("conversations", Conversation)):
        out[label] = int(
            await db.scalar(
                select(func.count()).select_from(table).where(table.behaviour_profile_id == profile_id)
            )
            or 0
        )
    return out


async def _out(db: DbDep, p: BehaviourProfile) -> ProfileOut:
    item = ProfileOut.model_validate(p)
    item.used_by = await _usage(db, p.id)
    return item


async def _get(db: DbDep, profile_id: str) -> BehaviourProfile:
    p = await db.get(BehaviourProfile, profile_id)
    if p is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "profile_not_found", "Behaviour profile not found.")
    return p


@router.get("", response_model=list[ProfileOut])
async def list_profiles(_: SessionDep, db: DbDep) -> list[ProfileOut]:
    rows = (await db.scalars(select(BehaviourProfile).order_by(BehaviourProfile.name))).all()
    return [await _out(db, p) for p in rows]


@router.post("", response_model=ProfileOut, status_code=status.HTTP_201_CREATED)
async def create_profile(body: ProfileIn, _: CsrfSessionDep, db: DbDep) -> ProfileOut:
    p = BehaviourProfile(**body.model_dump())
    p.name = p.name.strip()
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return await _out(db, p)


@router.put("/{profile_id}", response_model=ProfileOut)
async def update_profile(profile_id: str, body: ProfileIn, _: CsrfSessionDep, db: DbDep) -> ProfileOut:
    p = await _get(db, profile_id)
    for k, v in body.model_dump().items():
        setattr(p, k, v)
    await db.commit()
    await db.refresh(p)
    return await _out(db, p)


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_profile(profile_id: str, request: Request, _: CsrfSessionDep, db: DbDep) -> None:
    """Models, projects and chats using it go back to no profile."""
    p = await _get(db, profile_id)
    await db.delete(p)
    await audit.record(
        db, "profile.delete", target_type="profile", target_id=profile_id, client_ip=client_ip(request)
    )
    await db.commit()
