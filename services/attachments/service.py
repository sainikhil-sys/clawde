"""Uploaded files: storage, background processing, linking to messages, and building model context."""

from __future__ import annotations

import asyncio
import hashlib
import shutil
from collections.abc import Sequence
from pathlib import Path

import structlog
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.context.documents import DocumentSource, Passage
from core.inference.gateway import InferenceGateway
from core.inference.provider import ProviderError
from services.document_processing import extract as extraction
from services.document_processing.chunking import chunk_text
from services.document_processing.validation import UnsupportedFile, detect, sanitize_filename
from storage.database.base import new_id, utcnow
from storage.database.models import Attachment, DocumentChunk, MessageAttachment, ModelRecord
from storage.local_files.paths import safe_join

log = structlog.get_logger("clawde.attachments")

HEAD_BYTES = 8192
MAX_PER_MESSAGE = 10
EMBED_BATCH = 32


class UploadTooLarge(ValueError):
    pass


async def store_upload(
    db: AsyncSession,
    *,
    uploads_dir: Path,
    filename: str,
    stream: object,  # an object with async read(n) -> bytes (Starlette UploadFile)
    max_bytes: int,
    conversation_id: str | None = None,
    project_id: str | None = None,
) -> Attachment:
    """Validate and save an upload. Content is checked from the first bytes before the rest is accepted."""
    display_name = sanitize_filename(filename)
    attachment_id = new_id()
    folder = await asyncio.to_thread(_prepare_folder, uploads_dir, attachment_id)
    reader = stream.read  # type: ignore[attr-defined]
    try:
        head: bytes = await reader(HEAD_BYTES)
        ftype = detect(display_name, head)
        # Stored under a fixed name; only the final extension is kept (".env.example" -> ".example").
        suffix = "." + ftype.extension.rsplit(".", 1)[-1]
        target = safe_join(uploads_dir, f"{attachment_id}/original{suffix}")
        digest = hashlib.sha256(head)
        size = len(head)
        with target.open("wb") as fh:
            fh.write(head)
            while chunk := await reader(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise UploadTooLarge(
                        f"The file is larger than the {max_bytes // (1024 * 1024)} MB limit."
                    )
                digest.update(chunk)
                fh.write(chunk)
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise

    att = Attachment(
        id=attachment_id,
        conversation_id=conversation_id,
        project_id=project_id,
        filename=display_name,
        kind=ftype.kind,
        mime_type=ftype.mime_type,
        size_bytes=size,
        sha256=digest.hexdigest(),
        stored_path=target.relative_to(folder.parent).as_posix(),
        status="pending",
        meta={},
    )
    db.add(att)
    await db.flush()
    return att


def _prepare_folder(uploads_dir: Path, attachment_id: str) -> Path:
    uploads_dir.mkdir(parents=True, exist_ok=True)
    folder = safe_join(uploads_dir, attachment_id)
    folder.mkdir()
    return folder


def file_path(uploads_dir: Path, att: Attachment) -> Path:
    return safe_join(uploads_dir, att.stored_path)


async def find_embedding_model(db: AsyncSession) -> str | None:
    """An installed, available model that advertises embeddings, if any."""
    rows = (await db.scalars(select(ModelRecord).where(ModelRecord.available.is_(True)))).all()
    for rec in rows:
        if "embedding" in (rec.capabilities or []):
            return rec.id
    return None


async def process(
    sessionmaker: async_sessionmaker[AsyncSession],
    gateway: InferenceGateway,
    uploads_dir: Path,
    attachment_id: str,
) -> None:
    """Extract text, chunk it and (if an embedding model is installed) embed the chunks.

    Runs as a background task. Failures are recorded on the attachment, never raised to the caller.
    """
    async with sessionmaker() as db:
        att = await db.get(Attachment, attachment_id)
        if att is None:
            return
        att.status = "processing"
        await db.commit()
        path = file_path(uploads_dir, att)
        kind = att.kind

    try:
        result = await asyncio.to_thread(extraction.extract, kind, path)
        chunks = [] if kind == "image" else chunk_text(result.text)
        embed_model: str | None = None
        vectors: list[list[float]] | None = None
        async with sessionmaker() as db:
            embed_model = await find_embedding_model(db)
        if embed_model and chunks:
            try:
                vectors = []
                for i in range(0, len(chunks), EMBED_BATCH):
                    vectors += await gateway.embed(embed_model, [c.text for c in chunks[i : i + EMBED_BATCH]])
            except ProviderError as exc:
                log.warning("attachments.embed_failed", attachment_id=attachment_id, error=exc.message)
                vectors, embed_model = None, None

        async with sessionmaker() as db:
            att = await db.get(Attachment, attachment_id)
            if att is None:
                return
            await db.execute(delete(DocumentChunk).where(DocumentChunk.attachment_id == attachment_id))
            for i, c in enumerate(chunks):
                db.add(
                    DocumentChunk(
                        attachment_id=attachment_id,
                        ordinal=c.ordinal,
                        char_start=c.start,
                        char_end=c.end,
                        text=c.text,
                        embedding=vectors[i] if vectors else None,
                        embedding_model=embed_model if vectors else None,
                    )
                )
            att.extracted_text = result.text
            att.char_count = len(result.text)
            att.page_count = result.page_count
            att.meta = {
                **result.meta,
                "chunks": len(chunks),
                "embedding_model": embed_model if vectors else None,
            }
            att.status = "ready"
            att.error = None
            att.processed_at = utcnow()
            await db.commit()
        log.info(
            "attachments.ready",
            attachment_id=attachment_id,
            kind=kind,
            chars=len(result.text),
            chunks=len(chunks),
        )
    except Exception as exc:
        message = str(exc) if isinstance(exc, UnsupportedFile) else "The file couldn't be read."
        if not isinstance(exc, UnsupportedFile):
            log.exception("attachments.processing_failed", attachment_id=attachment_id)
        async with sessionmaker() as db:
            att = await db.get(Attachment, attachment_id)
            if att is not None:
                att.status = "failed"
                att.error = message
                att.processed_at = utcnow()
                await db.commit()


async def links_for_messages(db: AsyncSession, message_ids: Sequence[str]) -> dict[str, list[Attachment]]:
    if not message_ids:
        return {}
    rows = await db.execute(
        select(MessageAttachment.message_id, Attachment)
        .join(Attachment, Attachment.id == MessageAttachment.attachment_id)
        .where(MessageAttachment.message_id.in_(list(message_ids)))
        .order_by(MessageAttachment.position)
    )
    out: dict[str, list[Attachment]] = {}
    for message_id, att in rows.all():
        out.setdefault(message_id, []).append(att)
    return out


async def link(db: AsyncSession, message_id: str, attachments: Sequence[Attachment]) -> None:
    for pos, att in enumerate(attachments):
        db.add(MessageAttachment(message_id=message_id, attachment_id=att.id, position=pos))


async def chunks_for(db: AsyncSession, attachment_ids: Sequence[str]) -> dict[str, list[DocumentChunk]]:
    if not attachment_ids:
        return {}
    rows = await db.scalars(
        select(DocumentChunk)
        .where(DocumentChunk.attachment_id.in_(list(attachment_ids)))
        .order_by(DocumentChunk.attachment_id, DocumentChunk.ordinal)
    )
    out: dict[str, list[DocumentChunk]] = {}
    for c in rows:
        out.setdefault(c.attachment_id, []).append(c)
    return out


def to_sources(
    attachments: Sequence[Attachment],
    chunks: dict[str, list[DocumentChunk]],
    *,
    model_sees_images: bool,
    origin: str | None = None,
) -> list[DocumentSource]:
    sources: list[DocumentSource] = []
    for att in attachments:
        if att.kind == "image":
            w, h, fmt = att.meta.get("width"), att.meta.get("height"), att.meta.get("format")
            note = (
                f"Image {att.filename} ({w}x{h} {fmt}) is attached to the user's message "
                "and included for you to view."
                if model_sees_images
                else f"Image {att.filename} ({w}x{h} {fmt}) is attached, but the current model "
                "cannot view images. "
                "Tell the user if their question depends on the image."
            )
            sources.append(DocumentSource(att.id, att.filename, att.kind, "", note=note, origin=origin))
            continue
        passages = [
            Passage(ordinal=c.ordinal, start=c.char_start, text=c.text, embedding=c.embedding)
            for c in chunks.get(att.id, [])
        ]
        sources.append(
            DocumentSource(
                att.id,
                att.filename,
                att.kind,
                att.extracted_text or "",
                tuple(passages),
                page_count=att.page_count,
                origin=origin,
                whole_text_fallback=origin is None,
            )
        )
    return sources


async def resume_unfinished(
    sessionmaker: async_sessionmaker[AsyncSession], gateway: InferenceGateway, uploads_dir: Path
) -> list[asyncio.Task[None]]:
    """At startup, re-run processing for attachments interrupted by a restart."""
    async with sessionmaker() as db:
        ids = list(
            (
                await db.scalars(
                    select(Attachment.id).where(Attachment.status.in_(("pending", "processing")))
                )
            ).all()
        )
    return [asyncio.create_task(process(sessionmaker, gateway, uploads_dir, i)) for i in ids]


def remove_files(uploads_dir: Path, attachment_id: str) -> None:
    shutil.rmtree(safe_join(uploads_dir, attachment_id), ignore_errors=True)
