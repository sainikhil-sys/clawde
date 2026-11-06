"""Artifact storage: creation, versions, restore, and extraction from model replies."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.artifacts.parse import KINDS, parse_artifacts, slugify
from storage.database.base import utcnow
from storage.database.models import Artifact, ArtifactVersion, Conversation, Message

MAX_CONTENT_CHARS = 500_000

EXTENSIONS = {
    "html": ".html",
    "react": ".jsx",
    "svg": ".svg",
    "markdown": ".md",
    "mermaid": ".mmd",
    "chart": ".json",
    "javascript": ".js",
}
_CODE_EXTENSIONS = {
    "python": ".py",
    "py": ".py",
    "typescript": ".ts",
    "ts": ".ts",
    "css": ".css",
    "json": ".json",
    "bash": ".sh",
    "sh": ".sh",
    "shell": ".sh",
    "sql": ".sql",
    "rust": ".rs",
    "go": ".go",
    "java": ".java",
    "c": ".c",
    "cpp": ".cpp",
    "c++": ".cpp",
    "csharp": ".cs",
    "c#": ".cs",
    "yaml": ".yaml",
    "toml": ".toml",
    "ruby": ".rb",
    "php": ".php",
    "kotlin": ".kt",
    "swift": ".swift",
}


class ArtifactError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def file_extension(kind: str, language: str | None) -> str:
    if kind == "code":
        return _CODE_EXTENSIONS.get((language or "").lower(), ".txt")
    return EXTENSIONS.get(kind, ".txt")


def _check(kind: str, content: str) -> None:
    if kind not in KINDS:
        raise ArtifactError("invalid_kind", f"Unknown artifact type {kind!r}.")
    if not content.strip():
        raise ArtifactError("empty_artifact", "An artifact needs some content.")
    if len(content) > MAX_CONTENT_CHARS:
        raise ArtifactError(
            "artifact_too_large", f"Artifacts are limited to {MAX_CONTENT_CHARS:,} characters.", 413
        )


async def _unique_identifier(db: AsyncSession, conversation_id: str | None, wanted: str) -> str:
    base = slugify(wanted)
    stmt = select(Artifact.identifier).where(
        Artifact.conversation_id.is_(None)
        if conversation_id is None
        else Artifact.conversation_id == conversation_id
    )
    taken = set((await db.scalars(stmt)).all())
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


async def create(
    db: AsyncSession,
    *,
    kind: str,
    title: str,
    content: str,
    language: str | None = None,
    conversation_id: str | None = None,
    identifier: str | None = None,
    source: str = "user",
    message_id: str | None = None,
) -> Artifact:
    _check(kind, content)
    if conversation_id is not None and await db.get(Conversation, conversation_id) is None:
        raise ArtifactError("conversation_not_found", "Conversation not found.", 404)
    art = Artifact(
        identifier=await _unique_identifier(db, conversation_id, identifier or title),
        title=title.strip()[:200] or "Untitled",
        kind=kind,
        language=(language or None) if kind == "code" else None,
        conversation_id=conversation_id,
        current_version=1,
    )
    db.add(art)
    await db.flush()
    db.add(
        ArtifactVersion(artifact_id=art.id, version=1, content=content, source=source, message_id=message_id)
    )
    await db.flush()
    return art


async def current_content(db: AsyncSession, art: Artifact) -> str:
    v = await get_version(db, art.id, art.current_version)
    return v.content if v else ""


async def get_version(db: AsyncSession, artifact_id: str, version: int) -> ArtifactVersion | None:
    return await db.scalar(
        select(ArtifactVersion).where(
            ArtifactVersion.artifact_id == artifact_id, ArtifactVersion.version == version
        )
    )


async def versions(db: AsyncSession, artifact_id: str) -> list[ArtifactVersion]:
    stmt = (
        select(ArtifactVersion)
        .where(ArtifactVersion.artifact_id == artifact_id)
        .order_by(ArtifactVersion.version)
    )
    return list((await db.scalars(stmt)).all())


async def add_version(
    db: AsyncSession,
    art: Artifact,
    content: str,
    *,
    source: str,
    message_id: str | None = None,
    note: str = "",
    title: str | None = None,
) -> ArtifactVersion | None:
    """Append a version. Returns None when the content is unchanged (no empty versions)."""
    _check(art.kind, content)
    if title and title.strip():
        art.title = title.strip()[:200]
    if content == await current_content(db, art):
        art.updated_at = utcnow()
        return None
    latest = await db.scalar(
        select(func.max(ArtifactVersion.version)).where(ArtifactVersion.artifact_id == art.id)
    )
    version = ArtifactVersion(
        artifact_id=art.id,
        version=int(latest or 0) + 1,
        content=content,
        source=source,
        message_id=message_id,
        note=note[:300],
    )
    db.add(version)
    art.current_version = version.version
    art.updated_at = utcnow()
    await db.flush()
    return version


async def restore(db: AsyncSession, art: Artifact, version: int) -> ArtifactVersion | None:
    old = await get_version(db, art.id, version)
    if old is None:
        raise ArtifactError("version_not_found", "Version not found.", 404)
    return await add_version(db, art, old.content, source="restore", note=f"Restored version {version}")


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    id: str
    identifier: str
    title: str
    kind: str
    version: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "identifier": self.identifier,
            "title": self.title,
            "kind": self.kind,
            "version": self.version,
        }


async def extract_from_message(db: AsyncSession, msg: Message) -> list[ArtifactRef]:
    """Create or update artifacts for every complete `<artifact>` block in an assistant reply.

    A block whose identifier already exists in the conversation becomes a new version of that artifact."""
    refs: list[ArtifactRef] = []
    for block in parse_artifacts(msg.content):
        if len(block.content) > MAX_CONTENT_CHARS:
            continue
        art = await db.scalar(
            select(Artifact).where(
                Artifact.conversation_id == msg.conversation_id, Artifact.identifier == block.identifier
            )
        )
        if art is None:
            art = await create(
                db,
                kind=block.kind,
                title=block.title,
                content=block.content,
                language=block.language,
                conversation_id=msg.conversation_id,
                identifier=block.identifier,
                source="model",
                message_id=msg.id,
            )
            version = 1
        else:
            if art.kind != block.kind:
                art.kind = block.kind
            if block.kind == "code":
                art.language = block.language
            added = await add_version(
                db, art, block.content, source="model", message_id=msg.id, title=block.title
            )
            version = added.version if added else art.current_version
        refs.append(ArtifactRef(art.id, art.identifier, art.title, art.kind, version))
    return refs


async def refs_for_messages(db: AsyncSession, message_ids: Sequence[str]) -> dict[str, list[dict[str, Any]]]:
    """Artifacts each message produced (for showing cards on reload)."""
    if not message_ids:
        return {}
    rows = (
        await db.execute(
            select(ArtifactVersion.message_id, ArtifactVersion.version, Artifact)
            .join(Artifact, Artifact.id == ArtifactVersion.artifact_id)
            .where(ArtifactVersion.message_id.in_(list(message_ids)))
            .order_by(ArtifactVersion.id)
        )
    ).all()
    out: dict[str, list[dict[str, Any]]] = {}
    for message_id, version, art in rows:
        if message_id is None:
            continue
        out.setdefault(message_id, []).append(
            ArtifactRef(art.id, art.identifier, art.title, art.kind, version).as_dict()
        )
    return out


async def list_artifacts(
    db: AsyncSession,
    *,
    conversation_id: str | None = None,
    q: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[tuple[Artifact, int]]:
    counts = (
        select(ArtifactVersion.artifact_id, func.count().label("n"))
        .group_by(ArtifactVersion.artifact_id)
        .subquery()
    )
    stmt = select(Artifact, func.coalesce(counts.c.n, 0)).outerjoin(
        counts, counts.c.artifact_id == Artifact.id
    )
    if conversation_id:
        stmt = stmt.where(Artifact.conversation_id == conversation_id)
    if q and q.strip():
        pattern = "%" + q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        stmt = stmt.where(Artifact.title.ilike(pattern, escape="\\"))
    stmt = stmt.order_by(Artifact.updated_at.desc()).limit(limit).offset(offset)
    return [(a, int(n)) for a, n in (await db.execute(stmt)).all()]
