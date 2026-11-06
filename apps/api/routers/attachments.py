from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, File, Form, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select

from services.attachments import service as attachments
from services.audit import service as audit
from services.document_processing.validation import UnsupportedFile
from storage.database.models import Attachment, Conversation, MessageAttachment

from ..deps import DatabaseDep, DbDep, GatewayDep, SettingsDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip

router = APIRouter(prefix="/attachments", tags=["attachments"])

PREVIEW_MAX_CHARS = 200_000


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    conversation_id: str | None
    filename: str
    kind: str
    mime_type: str
    size_bytes: int
    status: str
    error: str | None
    char_count: int | None
    page_count: int | None
    meta: dict[str, Any]
    created_at: datetime


class AttachmentText(BaseModel):
    id: str
    offset: int
    text: str
    total_chars: int
    truncated: bool


async def _get(db: DbDep, attachment_id: str) -> Attachment:
    att = await db.get(Attachment, attachment_id)
    if att is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "attachment_not_found", "Attachment not found.")
    return att


def _schedule(
    request: Request, database: DatabaseDep, gateway: GatewayDep, settings: SettingsDep, att_id: str
) -> None:
    tasks: set[asyncio.Task[None]] = request.app.state.background_tasks
    task = asyncio.create_task(
        attachments.process(database.sessionmaker, gateway, settings.uploads_dir, att_id)
    )
    tasks.add(task)
    task.add_done_callback(tasks.discard)


@router.post("", response_model=AttachmentOut, status_code=status.HTTP_201_CREATED)
async def upload(
    request: Request,
    _: CsrfSessionDep,
    db: DbDep,
    database: DatabaseDep,
    gateway: GatewayDep,
    settings: SettingsDep,
    file: Annotated[UploadFile, File()],
    conversation_id: Annotated[str | None, Form(max_length=32)] = None,
) -> AttachmentOut:
    """Upload a file. It is validated now and processed (text extraction) in the background:
    poll `GET /api/attachments/{id}` until `status` is `ready` or `failed`."""
    if conversation_id is not None and await db.get(Conversation, conversation_id) is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "conversation_not_found", "Conversation not found.")
    try:
        att = await attachments.store_upload(
            db,
            uploads_dir=settings.uploads_dir,
            filename=file.filename or "file",
            stream=file,
            max_bytes=settings.max_upload_bytes,
            conversation_id=conversation_id,
        )
    except UnsupportedFile as exc:
        raise api_error(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "unsupported_file", str(exc)) from exc
    except attachments.UploadTooLarge as exc:
        raise api_error(status.HTTP_413_CONTENT_TOO_LARGE, "file_too_large", str(exc)) from exc
    finally:
        await file.close()
    await audit.record(
        db,
        "attachment.upload",
        target_type="attachment",
        target_id=att.id,
        details={"kind": att.kind, "size_bytes": att.size_bytes},
        client_ip=client_ip(request),
    )
    await db.commit()
    _schedule(request, database, gateway, settings, att.id)
    return AttachmentOut.model_validate(att)


@router.get("/{attachment_id}", response_model=AttachmentOut)
async def get_attachment(attachment_id: str, _: SessionDep, db: DbDep) -> AttachmentOut:
    return AttachmentOut.model_validate(await _get(db, attachment_id))


@router.get("/{attachment_id}/text", response_model=AttachmentText)
async def get_text(
    attachment_id: str,
    _: SessionDep,
    db: DbDep,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=PREVIEW_MAX_CHARS)] = 20_000,
) -> AttachmentText:
    """Extracted text for previews, in pages of `limit` characters."""
    att = await _get(db, attachment_id)
    if att.status != "ready":
        raise api_error(status.HTTP_409_CONFLICT, "not_ready", "The file hasn't finished processing.")
    text = att.extracted_text or ""
    part = text[offset : offset + limit]
    return AttachmentText(
        id=att.id, offset=offset, text=part, total_chars=len(text), truncated=offset + limit < len(text)
    )


@router.get("/{attachment_id}/content")
async def get_content(attachment_id: str, _: SessionDep, db: DbDep, settings: SettingsDep) -> Response:
    """The original file. Images are served inline for previews; everything else only as a download.

    Responses are sandboxed (CSP `sandbox`, nosniff) so a crafted file can never run as a page.
    """
    att = await _get(db, attachment_id)
    path = attachments.file_path(settings.uploads_dir, att)
    if not path.is_file():
        raise api_error(status.HTTP_410_GONE, "file_missing", "The stored file is missing.")
    inline = att.kind == "image"
    return FileResponse(
        path,
        media_type=att.mime_type if inline else "application/octet-stream",
        filename=att.filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Cache-Control": "private, no-store",
        },
    )


@router.delete("/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_attachment(
    attachment_id: str, request: Request, _: CsrfSessionDep, db: DbDep, settings: SettingsDep
) -> None:
    """Remove an attachment that hasn't been sent yet. Sent files are part of the conversation history and are
    deleted with it."""
    att = await _get(db, attachment_id)
    linked = await db.scalar(
        select(MessageAttachment.message_id).where(MessageAttachment.attachment_id == att.id)
    )
    if linked is not None:
        raise api_error(
            status.HTTP_409_CONFLICT,
            "attachment_in_use",
            "This file is part of a sent message; delete the conversation instead.",
        )
    await db.delete(att)
    await audit.record(
        db,
        "attachment.delete",
        target_type="attachment",
        target_id=attachment_id,
        client_ip=client_ip(request),
    )
    await db.commit()
    attachments.remove_files(settings.uploads_dir, attachment_id)
