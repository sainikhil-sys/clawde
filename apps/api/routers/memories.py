from __future__ import annotations

import asyncio
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, File, Form, Query, Request, Response, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from core.memory import ranking
from services.attachments.service import find_embedding_model
from services.audit import service as audit
from services.document_processing import extract as extraction
from services.document_processing.validation import (
    UnsupportedFile,
    check_office_zip,
    detect,
    sanitize_filename,
)
from services.memory import service as memory
from storage.database.base import utcnow
from storage.database.models import Conversation, Memory, Message, Project

from ..deps import DbDep, GatewayDep, SettingsDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip

router = APIRouter(prefix="/memories", tags=["memory"])

Kind = Literal["preference", "summary", "project", "knowledge", "temporary"]
#: Kinds the user creates directly. Summaries come from POST /api/conversations/{id}/summarise.
CreatableKind = Literal["preference", "project", "knowledge", "temporary"]


class MemoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    kind: str
    title: str
    content: str
    importance: int
    pinned: bool
    project_id: str | None
    conversation_id: str | None
    source: str
    meta: dict[str, Any]
    expires_at: datetime | None
    embedding_model: str | None
    use_count: int
    last_used_at: datetime | None
    created_at: datetime
    updated_at: datetime
    #: Display names for the scope, so lists don't need extra lookups.
    project_name: str | None = None
    conversation_title: str | None = None


class MemoryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: CreatableKind
    content: str = Field(min_length=1, max_length=memory.MAX_KNOWLEDGE_CHARS)
    title: str = Field(default="", max_length=200)
    importance: int = Field(default=3, ge=1, le=5)
    pinned: bool = False
    project_id: str | None = Field(default=None, max_length=32)
    conversation_id: str | None = Field(default=None, max_length=32)
    #: Temporary context only: hours until it expires (omit to keep it until deleted).
    expires_in_hours: int | None = Field(default=None, ge=1, le=24 * 365)
    #: The message this was saved from ("Remember this"), for provenance.
    source_message_id: str | None = Field(default=None, max_length=32)


class MemoryPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str | None = Field(default=None, min_length=1, max_length=memory.MAX_KNOWLEDGE_CHARS)
    title: str | None = Field(default=None, max_length=200)
    importance: int | None = Field(default=None, ge=1, le=5)
    pinned: bool | None = None
    expires_in_hours: int | None = Field(default=None, ge=1, le=24 * 365)
    clear_expiry: bool = False


class MemoryStats(BaseModel):
    counts: dict[str, int]
    total: int
    embedding_model: str | None


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=4000)
    project_id: str | None = Field(default=None, max_length=32)
    conversation_id: str | None = Field(default=None, max_length=32)
    token_budget: int = Field(default=1500, ge=100, le=8000)


class PreviewItem(BaseModel):
    id: str
    kind: str
    title: str
    passage: int
    text: str
    relevance: float
    importance: float
    recency: float
    score: float
    pinned: bool
    always: bool


class PreviewOut(BaseModel):
    candidates: int
    semantic: bool
    tokens: int
    skipped_for_budget: int
    chosen: list[PreviewItem]
    #: Eligible but not chosen (budget or per-memory limits), best first.
    others: list[PreviewItem]


def _raise(exc: memory.MemoryError) -> None:
    raise api_error(exc.status, exc.code, exc.message)


async def _out(db: DbDep, rows: list[Memory]) -> list[MemoryOut]:
    project_ids = {m.project_id for m in rows if m.project_id}
    conv_ids = {m.conversation_id for m in rows if m.conversation_id}
    names: dict[str, str] = {}
    titles: dict[str, str] = {}
    if project_ids:
        stmt = select(Project.id, Project.name).where(Project.id.in_(project_ids))
        names = {pid: name for pid, name in (await db.execute(stmt)).all()}
    if conv_ids:
        cstmt = select(Conversation.id, Conversation.title).where(Conversation.id.in_(conv_ids))
        titles = {cid: title for cid, title in (await db.execute(cstmt)).all()}
    return [
        MemoryOut.model_validate(m).model_copy(
            update={
                "project_name": names.get(m.project_id or ""),
                "conversation_title": titles.get(m.conversation_id or ""),
            }
        )
        for m in rows
    ]


async def _get(db: DbDep, memory_id: str) -> Memory:
    mem = await db.get(Memory, memory_id)
    if mem is None or (mem.expires_at is not None and mem.expires_at <= utcnow()):
        raise api_error(status.HTTP_404_NOT_FOUND, "memory_not_found", "Memory not found.")
    return mem


@router.get("", response_model=list[MemoryOut])
async def list_memories(
    _: SessionDep,
    db: DbDep,
    kind: Kind | None = None,
    project_id: Annotated[str | None, Query(max_length=32)] = None,
    conversation_id: Annotated[str | None, Query(max_length=32)] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[MemoryOut]:
    """Newest first (pinned on top), or best match first when `q` is given."""
    rows = await memory.list_memories(
        db, kind=kind, project_id=project_id, conversation_id=conversation_id, q=q, limit=limit, offset=offset
    )
    return await _out(db, rows)


@router.get("/stats", response_model=MemoryStats)
async def stats(_: SessionDep, db: DbDep) -> MemoryStats:
    counts = await memory.counts_by_kind(db)
    return MemoryStats(
        counts=counts,
        total=sum(counts.values()),
        embedding_model=await find_embedding_model(db),
    )


@router.post("", response_model=MemoryOut, status_code=status.HTTP_201_CREATED)
async def create_memory(
    body: MemoryCreate, request: Request, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep
) -> MemoryOut:
    meta: dict[str, Any] = {}
    source = "user"
    if body.source_message_id:
        msg = await db.get(Message, body.source_message_id)
        if msg is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "message_not_found", "Message not found.")
        meta = {"message_id": msg.id, "conversation_id": msg.conversation_id}
        source = "message"
    try:
        mem = await memory.create(
            db,
            gateway,
            kind=body.kind,
            content=body.content,
            title=body.title,
            importance=body.importance,
            pinned=body.pinned,
            project_id=body.project_id,
            conversation_id=body.conversation_id,
            expires_at=memory.default_expiry(body.expires_in_hours),
            source=source,
            meta=meta,
        )
    except memory.MemoryError as exc:
        _raise(exc)
    await audit.record(
        db,
        "memory.create",
        target_type="memory",
        target_id=mem.id,
        details={"kind": mem.kind, "source": source},
        client_ip=client_ip(request),
    )
    await db.commit()
    await db.refresh(mem)
    return (await _out(db, [mem]))[0]


@router.post("/import", response_model=MemoryOut, status_code=status.HTTP_201_CREATED)
async def import_knowledge(
    request: Request,
    _: CsrfSessionDep,
    db: DbDep,
    gateway: GatewayDep,
    settings: SettingsDep,
    file: Annotated[UploadFile, File()],
    title: Annotated[str | None, Form(max_length=200)] = None,
    importance: Annotated[int, Form(ge=1, le=5)] = 3,
) -> MemoryOut:
    """Turn a document into a knowledge memory. The file is validated and its text extracted (same rules as
    attachments); only the text is kept, the file itself is deleted afterwards."""
    filename = sanitize_filename(file.filename or "document")
    tmp_dir = settings.data_dir / "tmp"
    await asyncio.to_thread(tmp_dir.mkdir, parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=tmp_dir)
    os.close(fd)
    path = Path(name)
    try:
        head = await file.read(8192)
        try:
            ftype = detect(filename, head)
        except UnsupportedFile as exc:
            raise api_error(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "unsupported_file", str(exc)) from exc
        if ftype.kind == "image":
            raise api_error(
                status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                "unsupported_file",
                "Images have no text to remember (there is no OCR). Attach them to a chat instead.",
            )
        size = len(head)
        with path.open("wb") as fh:  # noqa: ASYNC230 - small local temp file
            fh.write(head)
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise api_error(
                        status.HTTP_413_CONTENT_TOO_LARGE,
                        "file_too_large",
                        f"The file is larger than the {settings.max_upload_bytes // (1024 * 1024)} MB limit.",
                    )
                fh.write(chunk)
        try:
            if ftype.kind in ("docx", "xlsx"):
                await asyncio.to_thread(check_office_zip, path, ftype.kind)
            extracted = await asyncio.to_thread(extraction.extract, ftype.kind, path)
        except UnsupportedFile as exc:
            raise api_error(status.HTTP_422_UNPROCESSABLE_CONTENT, "extraction_failed", str(exc)) from exc
    finally:
        await asyncio.to_thread(path.unlink, missing_ok=True)

    text = extracted.text.strip()
    if not text:
        raise api_error(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "no_text", "No text could be extracted from this file."
        )
    try:
        mem = await memory.create(
            db,
            gateway,
            kind="knowledge",
            content=text,
            title=(title or filename).strip(),
            importance=importance,
            source="import",
            meta={"filename": filename, "file_kind": ftype.kind, "chars": len(text)},
        )
    except memory.MemoryError as exc:
        _raise(exc)
    await audit.record(
        db,
        "memory.create",
        target_type="memory",
        target_id=mem.id,
        details={"kind": "knowledge", "source": "import"},
        client_ip=client_ip(request),
    )
    await db.commit()
    await db.refresh(mem)
    return (await _out(db, [mem]))[0]


@router.post("/preview", response_model=PreviewOut)
async def preview(body: PreviewRequest, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep) -> PreviewOut:
    """Show what would be recalled for a message, with the score breakdown. Doesn't mark anything as used."""
    conv = None
    if body.conversation_id:
        conv = await db.get(Conversation, body.conversation_id)
        if conv is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "conversation_not_found", "Conversation not found.")
    if body.project_id and await db.get(Project, body.project_id) is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "project_not_found", "Project not found.")
    result = await memory.recall(
        db,
        gateway,
        query=body.query,
        conversation=conv,
        token_budget=body.token_budget,
        project_id=body.project_id,
    )
    chosen_keys = {(c.id, c.passage) for c in result.selection.chosen}
    return PreviewOut(
        candidates=result.candidates,
        semantic=result.semantic,
        tokens=result.selection.tokens,
        skipped_for_budget=result.selection.skipped_for_budget,
        chosen=[PreviewItem(**_item(c)) for c in result.selection.chosen],
        others=[PreviewItem(**_item(c)) for c in result.eligible if (c.id, c.passage) not in chosen_keys][
            :20
        ],
    )


def _item(c: ranking.Scored) -> dict[str, Any]:
    return {
        "id": c.id,
        "kind": c.kind,
        "title": c.title,
        "passage": c.passage,
        "text": c.text[:600],
        "relevance": c.relevance,
        "importance": c.importance,
        "recency": c.recency,
        "score": c.score,
        "pinned": c.pinned,
        "always": c.always,
    }


@router.get("/export")
async def export(request: Request, _: SessionDep, db: DbDep) -> Response:
    rows = list((await db.scalars(select(Memory).order_by(Memory.created_at))).all())
    await audit.record(
        db, "memory.export", target_type="memory", details={"count": len(rows)}, client_ip=client_ip(request)
    )
    await db.commit()
    return Response(
        memory.export_payload(rows),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="clawde-memory.json"'},
    )


@router.get("/{memory_id}", response_model=MemoryOut)
async def get_memory(memory_id: str, _: SessionDep, db: DbDep) -> MemoryOut:
    return (await _out(db, [await _get(db, memory_id)]))[0]


@router.patch("/{memory_id}", response_model=MemoryOut)
async def update_memory(
    memory_id: str, body: MemoryPatch, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep
) -> MemoryOut:
    mem = await _get(db, memory_id)
    changes = body.model_dump(exclude_unset=True, exclude={"expires_in_hours", "clear_expiry"})
    if body.clear_expiry:
        changes["expires_at"] = None
    elif body.expires_in_hours is not None:
        changes["expires_at"] = memory.default_expiry(body.expires_in_hours)
    try:
        await memory.update_memory(db, gateway, mem, changes)
    except memory.MemoryError as exc:
        _raise(exc)
    await db.commit()
    await db.refresh(mem)
    return (await _out(db, [mem]))[0]


@router.delete("/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_memory(memory_id: str, request: Request, _: CsrfSessionDep, db: DbDep) -> None:
    mem = await db.get(Memory, memory_id)
    if mem is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "memory_not_found", "Memory not found.")
    kind = mem.kind
    await db.delete(mem)
    await audit.record(
        db,
        "memory.delete",
        target_type="memory",
        target_id=memory_id,
        details={"kind": kind},
        client_ip=client_ip(request),
    )
    await db.commit()


@router.delete("", status_code=status.HTTP_200_OK)
async def delete_all(
    request: Request, _: CsrfSessionDep, db: DbDep, confirm: Annotated[str, Query(max_length=20)] = ""
) -> dict[str, int]:
    """Delete every memory. Requires `?confirm=delete-all` so it can't happen by accident."""
    if confirm != "delete-all":
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            "confirmation_required",
            "Pass confirm=delete-all to delete all memory.",
        )
    count = await memory.delete_all(db)
    await audit.record(
        db, "memory.delete_all", target_type="memory", details={"count": count}, client_ip=client_ip(request)
    )
    await db.commit()
    return {"deleted": count}
