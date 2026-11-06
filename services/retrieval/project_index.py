"""Retrieval over a project's knowledge files: BM25 always, plus FAISS vector search when chunks are embedded.

Isolation: every query starts from chunks whose attachment belongs to the given project (a database filter),
and each project has its own FAISS file. A project can never retrieve another project's text.
"""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass
from pathlib import Path

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.inference.gateway import InferenceGateway
from core.inference.provider import ProviderError
from storage.database.models import Attachment, DocumentChunk
from storage.vector_index.faiss_index import VectorIndex

from .ranking import bm25_scores

log = structlog.get_logger("clawde.retrieval")

#: Candidates taken from each retriever before the final blended ranking.
CANDIDATES = 60


@dataclass(frozen=True, slots=True)
class ProjectKnowledge:
    attachments: list[Attachment]
    chunks: dict[str, list[DocumentChunk]]  # attachment id → candidate chunks (ordered)
    query_embedding: list[float] | None
    vector_search: bool


def index_for(indexes_dir: Path, project_id: str) -> VectorIndex:
    return VectorIndex(indexes_dir, f"project-{project_id}")


async def knowledge_chunks(db: AsyncSession, project_id: str) -> tuple[list[Attachment], list[DocumentChunk]]:
    atts = list(
        (
            await db.scalars(
                select(Attachment)
                .where(Attachment.project_id == project_id, Attachment.status == "ready")
                .order_by(Attachment.created_at)
            )
        ).all()
    )
    if not atts:
        return [], []
    chunks = list(
        (
            await db.scalars(
                select(DocumentChunk)
                .where(DocumentChunk.attachment_id.in_([a.id for a in atts]))
                .order_by(DocumentChunk.attachment_id, DocumentChunk.ordinal)
            )
        ).all()
    )
    return atts, chunks


def _signature(chunks: list[DocumentChunk], model: str) -> str:
    h = hashlib.sha256(model.encode())
    for c in sorted(chunks, key=lambda c: c.id):
        h.update(f"{c.id}:{c.embedding_model}".encode())
    return h.hexdigest()


async def ensure_index(indexes_dir: Path, project_id: str, chunks: list[DocumentChunk]) -> VectorIndex | None:
    """Return an up-to-date vector index for the project, rebuilding it if the chunks changed.

    None when no chunk has an embedding (no embedding model installed when the files were processed).
    """
    embedded = [c for c in chunks if c.embedding and c.embedding_model]
    if not embedded:
        return None
    # Use the most common model; chunks embedded by another model are left to BM25.
    models: dict[str, int] = {}
    for c in embedded:
        models[c.embedding_model or ""] = models.get(c.embedding_model or "", 0) + 1
    model = max(models, key=lambda m: models[m])
    usable = [c for c in embedded if c.embedding_model == model]
    signature = _signature(usable, model)
    index = index_for(indexes_dir, project_id)
    meta = await asyncio.to_thread(index.load)
    if meta is None or meta.signature != signature:
        await asyncio.to_thread(
            index.build,
            [c.id for c in usable],
            [list(c.embedding or []) for c in usable],
            model=model,
            signature=signature,
        )
        log.info("retrieval.index_built", project_id=project_id, vectors=len(usable), model=model)
    return index


async def retrieve(
    db: AsyncSession,
    gateway: InferenceGateway,
    indexes_dir: Path,
    project_id: str,
    query: str,
) -> ProjectKnowledge:
    """Candidate passages for `query` from this project's knowledge only."""
    atts, chunks = await knowledge_chunks(db, project_id)
    if not chunks:
        return ProjectKnowledge(atts, {}, None, False)

    chosen: dict[int, DocumentChunk] = {}
    scores = bm25_scores(query, [c.text for c in chunks])
    for i in sorted(range(len(chunks)), key=lambda i: -scores[i])[:CANDIDATES]:
        chosen[chunks[i].id] = chunks[i]

    query_vec: list[float] | None = None
    index = await ensure_index(indexes_dir, project_id, chunks)
    if index is not None and query.strip():
        meta = index.load()
        try:
            query_vec = (await gateway.embed(meta.model, [query]))[0] if meta else None
        except ProviderError as exc:
            log.warning("retrieval.query_embed_failed", error=exc.message)
        if query_vec is not None and meta is not None and len(query_vec) == meta.dim:
            by_id = {c.id: c for c in chunks}
            for chunk_id, _score in await asyncio.to_thread(index.search, query_vec, CANDIDATES):
                if chunk_id in by_id:  # ids outside this project's chunks are impossible, but never trusted
                    chosen[chunk_id] = by_id[chunk_id]

    grouped: dict[str, list[DocumentChunk]] = {}
    for c in sorted(chosen.values(), key=lambda c: (c.attachment_id, c.ordinal)):
        grouped.setdefault(c.attachment_id, []).append(c)
    return ProjectKnowledge(atts, grouped, query_vec, query_vec is not None)
