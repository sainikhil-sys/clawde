"""Assemble what the model sees for a turn: conversation history plus attached documents and images."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from core.context.budget import estimate_tokens, fit_history
from core.context.documents import build_document_context
from core.inference.gateway import InferenceGateway
from core.inference.provider import ProviderError
from core.inference.types import ChatMessage, GenerationParams, Role
from services.attachments import service as attachments
from services.retrieval import project_index
from storage.database.models import Attachment, Message, ModelRecord, Project

log = structlog.get_logger("clawde.context")

#: Share of the remaining context window documents may use (the rest is left for history growth).
DOCUMENT_SHARE = 0.85
MAX_IMAGE_BYTES = 10 * 1024 * 1024


@dataclass(slots=True)
class TurnContext:
    history: list[ChatMessage]
    dropped: int
    documents: dict[str, Any] = field(default_factory=dict)


def _marker(atts: list[Attachment]) -> str:
    return "\n".join(f"[Attached: {a.filename}]" for a in atts)


async def build_turn(
    db: AsyncSession,
    gateway: InferenceGateway,
    uploads_dir: Path,
    rows: list[Message],
    model: ModelRecord,
    params: GenerationParams,
    *,
    project: Project | None = None,
    indexes_dir: Path | None = None,
) -> TurnContext:
    """`project`: the conversation's project. Its instructions lead the context and its knowledge files are
    searched for passages relevant to the latest message."""
    links = await attachments.links_for_messages(db, [m.id for m in rows if m.role == "user"])
    sees_images = "vision" in (model.capabilities or [])

    messages: list[ChatMessage] = []
    all_atts: list[Attachment] = []
    seen: set[str] = set()
    for m in rows:
        if m.status == "error" or (not m.content.strip() and m.id not in links):
            continue
        atts = [a for a in links.get(m.id, []) if a.status == "ready"]
        for a in atts:
            if a.id not in seen:
                seen.add(a.id)
                all_atts.append(a)
        content = m.content
        images: tuple[bytes, ...] = ()
        if atts:
            content = f"{_marker(atts)}\n\n{content}".strip()
            if sees_images:
                images = tuple(
                    p.read_bytes()
                    for a in atts
                    if a.kind == "image"
                    and (p := attachments.file_path(uploads_dir, a)).is_file()
                    and a.size_bytes <= MAX_IMAGE_BYTES
                )
        role: Role = m.role  # type: ignore[assignment]  # validated on insert
        messages.append(ChatMessage(role=role, content=content, images=images))

    info: dict[str, Any] = {"mode": "none", "files": []}
    query = next((m.content for m in reversed(rows) if m.role == "user"), "")
    knowledge: project_index.ProjectKnowledge | None = None
    if project is not None and indexes_dir is not None:
        knowledge = await project_index.retrieve(db, gateway, indexes_dir, project.id, query)

    if all_atts or (knowledge and knowledge.attachments):
        history_tokens = sum(estimate_tokens(m.content) for m in messages)
        available = params.context_length - params.max_tokens - history_tokens
        budget = max(256, int(available * DOCUMENT_SHARE))
        chunks = await attachments.chunks_for(db, [a.id for a in all_atts])
        query_vec = await _query_embedding(gateway, chunks, query)
        sources = attachments.to_sources(all_atts, chunks, model_sees_images=sees_images)
        project_atts: list[Attachment] = []
        if knowledge is not None:
            project_atts = knowledge.attachments
            chunks.update(knowledge.chunks)
            query_vec = query_vec or knowledge.query_embedding
            sources += attachments.to_sources(
                project_atts, knowledge.chunks, model_sees_images=sees_images, origin="project knowledge"
            )
        doc_ctx = build_document_context(sources, query=query, token_budget=budget, query_embedding=query_vec)
        messages.insert(0, ChatMessage(role="system", content=doc_ctx.content))

        def describe(a: Attachment, origin: str) -> dict[str, Any]:
            return {
                "id": a.id,
                "filename": a.filename,
                "origin": origin,
                "excerpts": len(doc_ctx.used.get(a.id, [])) if doc_ctx.mode == "excerpts" else None,
                "total_excerpts": len(chunks.get(a.id, [])) if origin == "message" else None,
                "used": doc_ctx.mode == "full" or a.id in doc_ctx.used,
                "image_visible": sees_images if a.kind == "image" else None,
            }

        info = {
            "mode": doc_ctx.mode,
            "semantic": query_vec is not None,
            "files": [describe(a, "message") for a in all_atts]
            + [describe(a, "project") for a in project_atts],
        }

    if project is not None and project.instructions.strip():
        messages.insert(
            0,
            ChatMessage(
                role="system",
                content="Instructions from the user for every conversation in the project "
                f'"{project.name}":\n{project.instructions.strip()}',
            ),
        )

    history, dropped = fit_history(
        _merge_system(messages), context_length=params.context_length, reserve_for_output=params.max_tokens
    )
    return TurnContext(history=history, dropped=dropped, documents=info)


def _merge_system(messages: list[ChatMessage]) -> list[ChatMessage]:
    """Combine all system content into one leading message.

    Ollama concatenates multiple system messages itself, but other backends don't: many llama.cpp / Jinja chat
    templates reject or drop a second system message. Sending one keeps behaviour identical across backends.
    """
    system = [m.content for m in messages if m.role == "system" and m.content.strip()]
    rest = [m for m in messages if m.role != "system"]
    if not system:
        return rest
    return [ChatMessage(role="system", content="\n\n---\n\n".join(system)), *rest]


async def _query_embedding(
    gateway: InferenceGateway, chunks: dict[str, list[Any]], query: str
) -> list[float] | None:
    """Embed the question with the same model the chunks were embedded with, if any."""
    model_id = next((c.embedding_model for cs in chunks.values() for c in cs if c.embedding_model), None)
    if not model_id or not query.strip():
        return None
    try:
        return (await gateway.embed(model_id, [query]))[0]
    except ProviderError as exc:
        log.warning("context.query_embed_failed", error=exc.message)
        return None
