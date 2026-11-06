from __future__ import annotations

import asyncio
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, File, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask

from services.attachments import service as attachments
from services.audit import service as audit
from services.document_processing.validation import UnsupportedFile
from services.projects import service as projects
from services.retrieval import project_index
from storage.database.base import utcnow
from storage.database.models import Project

from ..deps import DatabaseDep, DbDep, GatewayDep, SettingsDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip
from .attachments import AttachmentOut, schedule_processing

router = APIRouter(prefix="/projects", tags=["projects"])

MAX_KNOWLEDGE_FILES = 200


class ProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    description: str
    instructions: str
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None
    conversation_count: int = 0
    knowledge_count: int = 0


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    instructions: str = Field(default="", max_length=20_000)


class ProjectPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    instructions: str | None = Field(default=None, max_length=20_000)
    archived: bool | None = None


class ProjectHitOut(BaseModel):
    kind: Literal["conversation", "knowledge"]
    id: str
    title: str
    snippet: str


async def get_project(db: DbDep, project_id: str) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "project_not_found", "Project not found.")
    return project


async def _out(db: DbDep, project: Project) -> ProjectOut:
    out = ProjectOut.model_validate(project)
    for stats in await projects.list_projects(db, archived=project.archived_at is not None):
        if stats.project.id == project.id:
            out.conversation_count, out.knowledge_count = stats.conversation_count, stats.knowledge_count
    return out


@router.get("", response_model=list[ProjectOut])
async def list_projects(_: SessionDep, db: DbDep, archived: bool = False) -> list[ProjectOut]:
    out = []
    for stats in await projects.list_projects(db, archived=archived):
        item = ProjectOut.model_validate(stats.project)
        item.conversation_count, item.knowledge_count = stats.conversation_count, stats.knowledge_count
        out.append(item)
    return out


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(body: ProjectCreate, _: CsrfSessionDep, db: DbDep) -> ProjectOut:
    project = Project(
        name=body.name.strip(), description=body.description.strip(), instructions=body.instructions
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return ProjectOut.model_validate(project)


@router.get("/{project_id}", response_model=ProjectOut)
async def get_one(project_id: str, _: SessionDep, db: DbDep) -> ProjectOut:
    return await _out(db, await get_project(db, project_id))


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(project_id: str, body: ProjectPatch, _: CsrfSessionDep, db: DbDep) -> ProjectOut:
    project = await get_project(db, project_id)
    if body.name is not None:
        project.name = body.name.strip()
    if body.description is not None:
        project.description = body.description.strip()
    if body.instructions is not None:
        project.instructions = body.instructions
    if body.archived is not None:
        project.archived_at = utcnow() if body.archived else None
    project.updated_at = utcnow()
    await db.commit()
    await db.refresh(project)
    return await _out(db, project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str, request: Request, _: CsrfSessionDep, db: DbDep, settings: SettingsDep
) -> None:
    """Deletes the project with all its conversations, knowledge files and search index."""
    project = await get_project(db, project_id)
    active: set[str] = request.app.state.active_generations
    file_ids, conv_ids = await projects.delete_project(db, project)
    if any(cid in active for cid in conv_ids):
        await db.rollback()
        raise api_error(
            status.HTTP_409_CONFLICT, "generation_in_progress", "A reply is still being generated."
        )
    await audit.record(
        db,
        "project.delete",
        target_type="project",
        target_id=project_id,
        details={"conversations": len(conv_ids), "files": len(file_ids)},
        client_ip=client_ip(request),
    )
    await db.commit()
    for file_id in file_ids:
        attachments.remove_files(settings.uploads_dir, file_id)
    project_index.index_for(settings.indexes_dir, project_id).delete()


@router.get("/{project_id}/knowledge", response_model=list[AttachmentOut])
async def list_knowledge(project_id: str, _: SessionDep, db: DbDep) -> list[AttachmentOut]:
    await get_project(db, project_id)
    return [AttachmentOut.model_validate(a) for a in await projects.knowledge(db, project_id)]


@router.post("/{project_id}/knowledge", response_model=AttachmentOut, status_code=status.HTTP_201_CREATED)
async def add_knowledge(
    project_id: str,
    request: Request,
    _: CsrfSessionDep,
    db: DbDep,
    database: DatabaseDep,
    gateway: GatewayDep,
    settings: SettingsDep,
    file: Annotated[UploadFile, File()],
) -> AttachmentOut:
    """Add a file to the project's knowledge. Every chat in the project can draw on it."""
    project = await get_project(db, project_id)
    if len(await projects.knowledge(db, project.id)) >= MAX_KNOWLEDGE_FILES:
        raise api_error(
            status.HTTP_409_CONFLICT, "too_many_files", f"A project can hold {MAX_KNOWLEDGE_FILES} files."
        )
    try:
        att = await attachments.store_upload(
            db,
            uploads_dir=settings.uploads_dir,
            filename=file.filename or "file",
            stream=file,
            max_bytes=settings.max_upload_bytes,
            project_id=project.id,
        )
    except UnsupportedFile as exc:
        raise api_error(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "unsupported_file", str(exc)) from exc
    except attachments.UploadTooLarge as exc:
        raise api_error(status.HTTP_413_CONTENT_TOO_LARGE, "file_too_large", str(exc)) from exc
    finally:
        await file.close()
    project.updated_at = utcnow()
    await audit.record(
        db,
        "project.knowledge_add",
        target_type="project",
        target_id=project.id,
        details={"attachment_id": att.id, "kind": att.kind, "size_bytes": att.size_bytes},
        client_ip=client_ip(request),
    )
    await db.commit()
    schedule_processing(request, database, gateway, settings, att.id)
    return AttachmentOut.model_validate(att)


@router.get("/{project_id}/search", response_model=list[ProjectHitOut])
async def search_project(
    project_id: str,
    _: SessionDep,
    db: DbDep,
    q: Annotated[str, Query(min_length=1, max_length=200)],
) -> list[ProjectHitOut]:
    await get_project(db, project_id)
    hits = await projects.search(db, project_id, q)
    return [ProjectHitOut(kind=h.kind, id=h.id, title=h.title, snippet=h.snippet) for h in hits]


@router.get("/{project_id}/export")
async def export_project(project_id: str, _: SessionDep, db: DbDep, settings: SettingsDep) -> FileResponse:
    """A zip with project.json, every conversation (JSON) and the knowledge files (original + text)."""
    project = await get_project(db, project_id)
    tmp_dir = settings.data_dir / "tmp"
    await asyncio.to_thread(tmp_dir.mkdir, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(suffix=".zip", dir=tmp_dir)
    os.close(fd)
    target = Path(name)
    try:
        await projects.export_zip(db, project, settings.uploads_dir, target)
    except BaseException:
        await asyncio.to_thread(target.unlink, missing_ok=True)
        raise
    slug = re.sub(r"[^a-z0-9]+", "-", project.name.lower()).strip("-")[:50] or "project"
    return FileResponse(
        target,
        media_type="application/zip",
        filename=f"{slug}-{utcnow():%Y%m%d}.zip",
        background=BackgroundTask(target.unlink, missing_ok=True),
    )
