from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from services.artifacts import service as artifacts
from services.audit import service as audit
from storage.database.models import Artifact, Conversation, Message

from ..deps import DbDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip

router = APIRouter(prefix="/artifacts", tags=["artifacts"])

Kind = Literal["html", "react", "svg", "markdown", "mermaid", "chart", "javascript", "code"]


class ArtifactOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    identifier: str
    title: str
    kind: str
    language: str | None
    conversation_id: str | None
    current_version: int
    created_at: datetime
    updated_at: datetime
    version_count: int = 1
    conversation_title: str | None = None


class ArtifactDetail(ArtifactOut):
    content: str


class VersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    version: int
    source: str
    message_id: str | None
    note: str
    created_at: datetime
    chars: int = 0


class VersionDetail(VersionOut):
    content: str


class ArtifactCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Kind
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=artifacts.MAX_CONTENT_CHARS)
    language: str | None = Field(default=None, max_length=40)
    conversation_id: str | None = Field(default=None, max_length=32)
    #: Created from a code block in this message ("Open as artifact").
    source_message_id: str | None = Field(default=None, max_length=32)


class ArtifactPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)


class ContentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=artifacts.MAX_CONTENT_CHARS)
    note: str = Field(default="", max_length=300)


class SaveResult(BaseModel):
    artifact: ArtifactDetail
    #: False when the content was identical to the current version (nothing saved).
    changed: bool


def _raise(exc: artifacts.ArtifactError) -> None:
    raise api_error(exc.status, exc.code, exc.message)


async def _get(db: DbDep, artifact_id: str) -> Artifact:
    art = await db.get(Artifact, artifact_id)
    if art is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "artifact_not_found", "Artifact not found.")
    return art


async def _detail(db: DbDep, art: Artifact) -> ArtifactDetail:
    count = len(await artifacts.versions(db, art.id))
    title = None
    if art.conversation_id:
        title = await db.scalar(select(Conversation.title).where(Conversation.id == art.conversation_id))
    return ArtifactDetail.model_validate(
        {
            **ArtifactOut.model_validate(art).model_dump(),
            "version_count": count,
            "conversation_title": title,
            "content": await artifacts.current_content(db, art),
        }
    )


@router.get("", response_model=list[ArtifactOut])
async def list_artifacts(
    _: SessionDep,
    db: DbDep,
    conversation_id: Annotated[str | None, Query(max_length=32)] = None,
    q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[ArtifactOut]:
    rows = await artifacts.list_artifacts(
        db, conversation_id=conversation_id, q=q, limit=limit, offset=offset
    )
    conv_ids = {a.conversation_id for a, _ in rows if a.conversation_id}
    titles: dict[str, str] = {}
    if conv_ids:
        stmt = select(Conversation.id, Conversation.title).where(Conversation.id.in_(conv_ids))
        titles = {cid: t for cid, t in (await db.execute(stmt)).all()}
    return [
        ArtifactOut.model_validate(a).model_copy(
            update={"version_count": n, "conversation_title": titles.get(a.conversation_id or "")}
        )
        for a, n in rows
    ]


@router.post("", response_model=ArtifactDetail, status_code=status.HTTP_201_CREATED)
async def create_artifact(body: ArtifactCreate, _: CsrfSessionDep, db: DbDep) -> ArtifactDetail:
    conversation_id = body.conversation_id
    if body.source_message_id:
        msg = await db.get(Message, body.source_message_id)
        if msg is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "message_not_found", "Message not found.")
        conversation_id = msg.conversation_id
    try:
        art = await artifacts.create(
            db,
            kind=body.kind,
            title=body.title,
            content=body.content,
            language=body.language,
            conversation_id=conversation_id,
            source="user",
            message_id=body.source_message_id,
        )
    except artifacts.ArtifactError as exc:
        _raise(exc)
    await db.commit()
    await db.refresh(art)
    return await _detail(db, art)


@router.get("/{artifact_id}", response_model=ArtifactDetail)
async def get_artifact(artifact_id: str, _: SessionDep, db: DbDep) -> ArtifactDetail:
    return await _detail(db, await _get(db, artifact_id))


@router.patch("/{artifact_id}", response_model=ArtifactDetail)
async def rename_artifact(
    artifact_id: str, body: ArtifactPatch, _: CsrfSessionDep, db: DbDep
) -> ArtifactDetail:
    art = await _get(db, artifact_id)
    art.title = body.title.strip() or art.title
    await db.commit()
    await db.refresh(art)
    return await _detail(db, art)


@router.put("/{artifact_id}/content", response_model=SaveResult)
async def save_content(artifact_id: str, body: ContentUpdate, _: CsrfSessionDep, db: DbDep) -> SaveResult:
    """Save edited source as a new version (unchanged content creates nothing)."""
    art = await _get(db, artifact_id)
    try:
        added = await artifacts.add_version(db, art, body.content, source="user", note=body.note)
    except artifacts.ArtifactError as exc:
        _raise(exc)
    await db.commit()
    await db.refresh(art)
    return SaveResult(artifact=await _detail(db, art), changed=added is not None)


@router.get("/{artifact_id}/versions", response_model=list[VersionOut])
async def list_versions(artifact_id: str, _: SessionDep, db: DbDep) -> list[VersionOut]:
    await _get(db, artifact_id)
    return [
        VersionOut.model_validate(v).model_copy(update={"chars": len(v.content)})
        for v in await artifacts.versions(db, artifact_id)
    ]


@router.get("/{artifact_id}/versions/{version}", response_model=VersionDetail)
async def get_version(artifact_id: str, version: int, _: SessionDep, db: DbDep) -> VersionDetail:
    await _get(db, artifact_id)
    v = await artifacts.get_version(db, artifact_id, version)
    if v is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "version_not_found", "Version not found.")
    return VersionDetail.model_validate(v).model_copy(update={"chars": len(v.content)})


@router.post("/{artifact_id}/versions/{version}/restore", response_model=SaveResult)
async def restore_version(artifact_id: str, version: int, _: CsrfSessionDep, db: DbDep) -> SaveResult:
    """Make an old version current again by copying it into a new version (history is never rewritten)."""
    art = await _get(db, artifact_id)
    try:
        added = await artifacts.restore(db, art, version)
    except artifacts.ArtifactError as exc:
        _raise(exc)
    await db.commit()
    await db.refresh(art)
    return SaveResult(artifact=await _detail(db, art), changed=added is not None)


def _filename(art: Artifact, version: int) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", art.title).strip("-.")[:80] or "artifact"
    return f"{stem}-v{version}{artifacts.file_extension(art.kind, art.language)}"


@router.get("/{artifact_id}/download")
async def download(
    artifact_id: str, _: SessionDep, db: DbDep, version: Annotated[int | None, Query(ge=1)] = None
) -> Response:
    """The source as a file. Always sent as a download (never rendered by the browser on the API origin)."""
    art = await _get(db, artifact_id)
    n = version or art.current_version
    v = await artifacts.get_version(db, art.id, n)
    if v is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "version_not_found", "Version not found.")
    return Response(
        v.content.encode("utf-8"),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{_filename(art, n)}"',
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@router.delete("/{artifact_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_artifact(artifact_id: str, request: Request, _: CsrfSessionDep, db: DbDep) -> None:
    art = await _get(db, artifact_id)
    count = len(await artifacts.versions(db, art.id))
    await db.delete(art)
    await audit.record(
        db,
        "artifact.delete",
        target_type="artifact",
        target_id=artifact_id,
        details={"kind": art.kind, "versions": count},
        client_ip=client_ip(request),
    )
    await db.commit()
