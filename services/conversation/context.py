"""Assemble what the model sees for a turn.

System context, in order: project instructions, saved memory, the conversation's rolling summary (only when
older messages had to be dropped), then attached documents and project knowledge. History fills the rest.
"""

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
from core.memory import ranking as memory_ranking
from core.memory.render import render_memories, render_summary
from services.attachments import service as attachments
from services.memory import service as memory
from services.retrieval import project_index
from storage.database.models import Attachment, Conversation, Message, ModelRecord, Project

log = structlog.get_logger("clawde.context")

#: Share of the remaining context window documents may use (the rest is left for history growth).
DOCUMENT_SHARE = 0.85
MAX_IMAGE_BYTES = 10 * 1024 * 1024


@dataclass(slots=True)
class TurnContext:
    history: list[ChatMessage]
    dropped: int
    documents: dict[str, Any] = field(default_factory=dict)
    #: What saved memory was used (shown to the user): ids, kinds, scores, rolling-summary flag.
    memory: dict[str, Any] = field(default_factory=dict)
    memory_ids: list[str] = field(default_factory=list)


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
    conversation: Conversation | None = None,
    use_memory: bool = False,
) -> TurnContext:
    """`project`: the conversation's project. Its instructions lead the context and its knowledge files are
    searched for passages relevant to the latest message. `use_memory`: recall saved memory in scope for
    `conversation` (see services/memory for the scope rules)."""
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
    history_tokens = sum(estimate_tokens(m.content) for m in messages)
    window = params.context_length - params.max_tokens

    # Saved memory gets a bounded share of the window. Old history is dropped before memory is.
    memory_text = ""
    memory_info: dict[str, Any] = {"enabled": use_memory, "used": [], "summary_used": False}
    recall: memory.Recall | None = None
    if use_memory:
        budget = memory_ranking.memory_budget(window - min(history_tokens, window // 2))
        recall = await memory.recall(db, gateway, query=query, conversation=conversation, token_budget=budget)
        memory_text = render_memories(recall.selection.chosen)
        memory_info.update(
            candidates=recall.candidates,
            semantic=recall.semantic,
            skipped_for_budget=recall.selection.skipped_for_budget,
            used=[
                {
                    "id": c.id,
                    "kind": c.kind,
                    "title": c.title,
                    "score": c.score,
                    "relevance": c.relevance,
                    "pinned": c.pinned,
                }
                for c in recall.selection.chosen
            ],
        )

    knowledge: project_index.ProjectKnowledge | None = None
    if project is not None and indexes_dir is not None:
        knowledge = await project_index.retrieve(db, gateway, indexes_dir, project.id, query)

    doc_text = ""
    if all_atts or (knowledge and knowledge.attachments):
        available = window - history_tokens - (estimate_tokens(memory_text) if memory_text else 0)
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
        doc_text = doc_ctx.content

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

    instructions = ""
    if project is not None and project.instructions.strip():
        instructions = (
            f'Instructions from the user for every conversation in the project "{project.name}":\n'
            f"{project.instructions.strip()}"
        )

    def assemble(summary: str) -> tuple[list[ChatMessage], int]:
        system = [t for t in (instructions, memory_text, summary, doc_text) if t]
        full = [ChatMessage(role="system", content=t) for t in system] + messages
        return fit_history(
            _merge_system(full), context_length=params.context_length, reserve_for_output=params.max_tokens
        )

    history, dropped = assemble("")
    if dropped and recall is not None and recall.summary is not None:
        # Older messages fell out of the window: stand in for them with the conversation's summary.
        history, dropped = assemble(render_summary(recall.summary.content))
        memory_info["summary_used"] = True
        memory_info["summary_id"] = recall.summary.id

    ids = [u["id"] for u in memory_info["used"]]
    if memory_info["summary_used"]:
        ids.append(memory_info["summary_id"])
    ids = list(dict.fromkeys(ids))
    if ids:
        await memory.mark_used(db, ids)
    return TurnContext(history=history, dropped=dropped, documents=info, memory=memory_info, memory_ids=ids)


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
