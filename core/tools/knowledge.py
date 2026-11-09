"""Search tools over local data.

They respect the run's scope: with a project, only that project's data; without one, only data outside
projects (project isolation from Milestone 7 holds for agents too)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select

from services.memory import service as memory
from services.projects import service as projects
from services.retrieval.ranking import bm25_scores
from storage.database.models import Attachment, Conversation, DocumentChunk

from .base import Tool, ToolContext, ToolResult, clip

MAX_HITS = 6


class SearchArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=500, description="What to look for")


async def _search_documents(ctx: ToolContext, args: SearchArgs) -> ToolResult:
    async with ctx.sessionmaker() as db:
        stmt = (
            select(DocumentChunk, Attachment.filename)
            .join(Attachment, Attachment.id == DocumentChunk.attachment_id)
            .outerjoin(Conversation, Conversation.id == Attachment.conversation_id)
            .where(Attachment.status == "ready")
        )
        if ctx.project_id:
            stmt = stmt.where(
                or_(Attachment.project_id == ctx.project_id, Conversation.project_id == ctx.project_id)
            )
        else:
            stmt = stmt.where(Attachment.project_id.is_(None), Conversation.project_id.is_(None))
        rows = (await db.execute(stmt.limit(20_000))).all()
    if not rows:
        return ToolResult(output="No documents are available in this scope.", data={"hits": 0})
    scores = bm25_scores(args.query, [c.text for c, _ in rows])
    ranked = sorted(
        ((s, c, name) for s, (c, name) in zip(scores, rows, strict=True) if s > 0), key=lambda x: -x[0]
    )[:MAX_HITS]
    if not ranked:
        return ToolResult(output=f"No passages match {args.query!r}.", data={"hits": 0})
    parts = [f"[{name}, passage {c.ordinal + 1}]\n{c.text}" for _, c, name in ranked]
    return ToolResult(
        output=clip("\n\n".join(parts)),
        data={"hits": len(ranked), "files": sorted({name for _, _, name in ranked})},
        untrusted=True,
    )


async def _search_knowledge(ctx: ToolContext, args: SearchArgs) -> ToolResult:
    async with ctx.sessionmaker() as db:
        recall = await memory.recall(
            db, ctx.gateway, query=args.query, conversation=None, token_budget=2000, project_id=ctx.project_id
        )
    chosen = recall.selection.chosen
    if not chosen:
        return ToolResult(output="No saved memory matches.", data={"hits": 0})
    parts = [f"[{c.kind}{': ' + c.title if c.title else ''}]\n{c.text}" for c in chosen]
    return ToolResult(
        output=clip("\n\n".join(parts)),
        data={"hits": len(chosen), "memory_ids": recall.selection.memory_ids},
        untrusted=True,
    )


async def _search_project(ctx: ToolContext, args: SearchArgs) -> ToolResult:
    assert ctx.project_id is not None  # registry only offers this tool to project-scoped runs
    async with ctx.sessionmaker() as db:
        hits = await projects.search(db, ctx.project_id, args.query, limit=10)
    if not hits:
        return ToolResult(output=f"Nothing in this project matches {args.query!r}.", data={"hits": 0})
    parts = [f"[{h.kind}: {h.title}] {h.snippet}" for h in hits]
    return ToolResult(output=clip("\n".join(parts)), data={"hits": len(hits)}, untrusted=True)


SEARCH_DOCUMENTS = Tool(
    name="search_documents",
    description="Search the text of uploaded documents (chat attachments and project knowledge in scope).",
    risk="read",
    args_model=SearchArgs,
    run=_search_documents,
)
SEARCH_KNOWLEDGE = Tool(
    name="search_knowledge",
    description="Search the user's saved memory and knowledge notes.",
    risk="read",
    args_model=SearchArgs,
    run=_search_knowledge,
)
SEARCH_PROJECT = Tool(
    name="search_project",
    description="Search this project's conversations and knowledge files.",
    risk="read",
    args_model=SearchArgs,
    run=_search_project,
    needs_project=True,
)
