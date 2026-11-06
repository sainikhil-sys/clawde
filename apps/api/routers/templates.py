from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from storage.database.models import PromptTemplate

from ..deps import DbDep
from ..security import CsrfSessionDep, SessionDep, api_error

router = APIRouter(prefix="/templates", tags=["templates"])


class TemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    content: str
    created_at: datetime
    updated_at: datetime


class TemplateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000)


class TemplatePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, min_length=1, max_length=20_000)


async def _get(db: DbDep, template_id: str) -> PromptTemplate:
    tpl = await db.get(PromptTemplate, template_id)
    if tpl is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "template_not_found", "Template not found.")
    return tpl


@router.get("", response_model=list[TemplateOut])
async def list_templates(_: SessionDep, db: DbDep) -> list[TemplateOut]:
    rows = await db.scalars(select(PromptTemplate).order_by(func.lower(PromptTemplate.name)))
    return [TemplateOut.model_validate(t) for t in rows]


@router.post("", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
async def create_template(body: TemplateIn, _: CsrfSessionDep, db: DbDep) -> TemplateOut:
    tpl = PromptTemplate(name=body.name.strip(), content=body.content)
    db.add(tpl)
    await db.commit()
    await db.refresh(tpl)
    return TemplateOut.model_validate(tpl)


@router.patch("/{template_id}", response_model=TemplateOut)
async def update_template(template_id: str, body: TemplatePatch, _: CsrfSessionDep, db: DbDep) -> TemplateOut:
    tpl = await _get(db, template_id)
    if body.name is not None:
        tpl.name = body.name.strip()
    if body.content is not None:
        tpl.content = body.content
    await db.commit()
    await db.refresh(tpl)
    return TemplateOut.model_validate(tpl)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(template_id: str, _: CsrfSessionDep, db: DbDep) -> None:
    await db.delete(await _get(db, template_id))
    await db.commit()
