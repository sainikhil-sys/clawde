"""Projects: listing with counts, search within a project, export as a zip, and complete deletion."""

from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from services.attachments import service as attachments
from services.conversation import service as conversations
from services.retrieval import project_index
from services.retrieval.ranking import bm25_scores
from storage.database.models import Attachment, Conversation, DocumentChunk, Project


@dataclass(frozen=True, slots=True)
class ProjectStats:
    project: Project
    conversation_count: int
    knowledge_count: int


async def list_projects(db: AsyncSession, *, archived: bool = False) -> list[ProjectStats]:
    conv_counts = (
        select(Conversation.project_id, func.count(Conversation.id).label("n"))
        .where(Conversation.project_id.is_not(None))
        .group_by(Conversation.project_id)
        .subquery()
    )
    file_counts = (
        select(Attachment.project_id, func.count(Attachment.id).label("n"))
        .where(Attachment.project_id.is_not(None))
        .group_by(Attachment.project_id)
        .subquery()
    )
    stmt = (
        select(Project, func.coalesce(conv_counts.c.n, 0), func.coalesce(file_counts.c.n, 0))
        .outerjoin(conv_counts, conv_counts.c.project_id == Project.id)
        .outerjoin(file_counts, file_counts.c.project_id == Project.id)
        .where(Project.archived_at.is_(None) if not archived else Project.archived_at.is_not(None))
        .order_by(Project.updated_at.desc())
    )
    return [ProjectStats(p, int(c), int(f)) for p, c, f in (await db.execute(stmt)).all()]


async def knowledge(db: AsyncSession, project_id: str) -> list[Attachment]:
    return list(
        (
            await db.scalars(
                select(Attachment).where(Attachment.project_id == project_id).order_by(Attachment.created_at)
            )
        ).all()
    )


@dataclass(frozen=True, slots=True)
class ProjectHit:
    kind: Literal["conversation", "knowledge"]
    id: str
    title: str
    snippet: str


async def search(db: AsyncSession, project_id: str, query: str, *, limit: int = 20) -> list[ProjectHit]:
    """Conversations (title or message text) and knowledge passages in this project only."""
    q = query.strip()
    if not q:
        return []
    hits: list[ProjectHit] = []
    for h in await conversations.search(db, q, limit=200):
        if h.conversation.project_id == project_id:
            hits.append(ProjectHit("conversation", h.conversation.id, h.conversation.title, h.snippet))
    atts, chunks = await project_index.knowledge_chunks(db, project_id)
    if chunks:
        names = {a.id: a.filename for a in atts}
        scores = bm25_scores(q, [c.text for c in chunks])
        best: dict[str, tuple[float, DocumentChunk]] = {}
        for score, chunk in zip(scores, chunks, strict=True):
            if score > 0 and (chunk.attachment_id not in best or score > best[chunk.attachment_id][0]):
                best[chunk.attachment_id] = (score, chunk)
        for _score, chunk in sorted(best.values(), key=lambda x: -x[0]):
            hits.append(
                ProjectHit(
                    "knowledge",
                    chunk.attachment_id,
                    names[chunk.attachment_id],
                    conversations.make_snippet(chunk.text, q),
                )
            )
    return hits[:limit]


def _safe_name(name: str, used: set[str]) -> str:
    base = re.sub(r"[^\w.\- ]+", "_", name).strip() or "file"
    candidate, n = base, 2
    while candidate.lower() in used:
        stem, dot, ext = base.rpartition(".")
        candidate = f"{stem} ({n}){dot}{ext}" if dot else f"{base} ({n})"
        n += 1
    used.add(candidate.lower())
    return candidate


async def export_zip(db: AsyncSession, project: Project, uploads_dir: Path, target: Path) -> None:
    """Everything needed to understand or restore the project: metadata, conversations, knowledge files."""
    convs = list((await db.scalars(select(Conversation).where(Conversation.project_id == project.id))).all())
    files = await knowledge(db, project.id)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "project.json",
            json.dumps(
                {
                    "format": "clawde.project.v1",
                    "exported_at": datetime.now(UTC).isoformat(),
                    "project": {
                        "id": project.id,
                        "name": project.name,
                        "description": project.description,
                        "instructions": project.instructions,
                        "created_at": project.created_at.isoformat(),
                        "updated_at": project.updated_at.isoformat(),
                    },
                    "conversations": [c.id for c in convs],
                    "knowledge": [{"id": a.id, "filename": a.filename, "kind": a.kind} for a in files],
                },
                ensure_ascii=False,
                indent=2,
            ),
        )
        used: set[str] = set()
        for conv in convs:
            path, tree = await conversations.active_path(db, conv)
            name = _safe_name(conversations.export_filename(conv, "json"), used)
            zf.writestr(f"conversations/{name}", conversations.export_json(conv, tree, path))
        used = set()
        for att in files:
            name = _safe_name(att.filename, used)
            src = attachments.file_path(uploads_dir, att)
            if src.is_file():
                zf.write(src, f"knowledge/{name}")
            if att.extracted_text and att.kind != "image":
                zf.writestr(f"knowledge/extracted/{name}.txt", att.extracted_text)


async def delete_project(db: AsyncSession, project: Project) -> tuple[list[str], list[str]]:
    """Delete the project row (conversations, messages and knowledge rows cascade).

    Returns (attachment ids whose files must be removed from disk, conversation ids). The caller commits,
    then removes files and the vector index.
    """
    conv_ids = list(
        (await db.scalars(select(Conversation.id).where(Conversation.project_id == project.id))).all()
    )
    file_ids = list(
        (await db.scalars(select(Attachment.id).where(Attachment.project_id == project.id))).all()
    )
    if conv_ids:
        file_ids += list(
            (await db.scalars(select(Attachment.id).where(Attachment.conversation_id.in_(conv_ids)))).all()
        )
    await db.delete(project)
    return file_ids, conv_ids
