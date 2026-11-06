"""User settings stored in the database, validated by a single typed model."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from storage.database.models import Setting


class AppSettings(BaseModel):
    """All user-controllable settings. Unknown keys are rejected."""

    model_config = ConfigDict(extra="forbid")

    #: Master switch for outbound internet (model/dataset downloads). Off by default; enforced from M11.
    network_access_enabled: bool = False
    #: Model used when a conversation has none selected. Wired up in Milestone 4.
    default_model: str | None = Field(default=None, max_length=200)


class AppSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    network_access_enabled: bool | None = None
    default_model: str | None = Field(default=None, max_length=200)


async def load(db: AsyncSession) -> AppSettings:
    rows = (await db.scalars(select(Setting))).all()
    stored = {r.key: r.value for r in rows if r.key in AppSettings.model_fields}
    return AppSettings.model_validate(stored)


async def apply_patch(db: AsyncSession, patch: AppSettingsPatch) -> tuple[AppSettings, dict[str, Any]]:
    """Validate and store only the fields present in the patch. Returns new settings and a change diff."""
    current = await load(db)
    updates = patch.model_dump(exclude_unset=True)
    merged = AppSettings.model_validate({**current.model_dump(), **updates})
    changes: dict[str, Any] = {}
    for key in updates:
        old, new = getattr(current, key), getattr(merged, key)
        if old == new:
            continue
        changes[key] = {"from": old, "to": new}
        row = await db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=new))
        else:
            row.value = new
    return merged, changes
