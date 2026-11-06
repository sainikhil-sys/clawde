from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from services.audit import service as audit
from storage.database.models import Conversation, Folder

from ..deps import DbDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip

router = APIRouter(prefix="/folders", tags=["folders"])


class FolderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    created_at: datetime
    updated_at: datetime
    conversation_count: int = 0


class FolderIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)


async def _get(db: DbDep, folder_id: str) -> Folder:
    folder = await db.get(Folder, folder_id)
    if folder is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "folder_not_found", "Folder not found.")
    return folder


@router.get("", response_model=list[FolderOut])
async def list_folders(_: SessionDep, db: DbDep) -> list[FolderOut]:
    counts = (
        select(Conversation.folder_id, func.count(Conversation.id).label("n"))
        .where(Conversation.archived.is_(False))
        .group_by(Conversation.folder_id)
        .subquery()
    )
    rows = await db.execute(
        select(Folder, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.folder_id == Folder.id)
        .order_by(func.lower(Folder.name))
    )
    out = []
    for folder, n in rows.all():
        item = FolderOut.model_validate(folder)
        item.conversation_count = int(n)
        out.append(item)
    return out


@router.post("", response_model=FolderOut, status_code=status.HTTP_201_CREATED)
async def create_folder(body: FolderIn, _: CsrfSessionDep, db: DbDep) -> FolderOut:
    folder = Folder(name=body.name.strip())
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return FolderOut.model_validate(folder)


@router.patch("/{folder_id}", response_model=FolderOut)
async def rename_folder(folder_id: str, body: FolderIn, _: CsrfSessionDep, db: DbDep) -> FolderOut:
    folder = await _get(db, folder_id)
    folder.name = body.name.strip()
    await db.commit()
    await db.refresh(folder)
    return FolderOut.model_validate(folder)


@router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(folder_id: str, request: Request, _: CsrfSessionDep, db: DbDep) -> None:
    """Deletes the folder only; its conversations are kept and become unfiled."""
    folder = await _get(db, folder_id)
    await db.delete(folder)
    await audit.record(
        db, "folder.delete", target_type="folder", target_id=folder_id, client_ip=client_ip(request)
    )
    await db.commit()
