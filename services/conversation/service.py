"""Conversation and message persistence."""

from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.inference.types import ChatMessage, Role
from storage.database.base import utcnow
from storage.database.models import Conversation, Message

TITLE_MAX_CHARS = 60
DEFAULT_TITLE = "New conversation"


def title_from_text(text: str) -> str:
    """First line of the first message, trimmed at a word boundary. Model-generated titles come in M5."""
    line = " ".join(text.strip().split())
    if len(line) <= TITLE_MAX_CHARS:
        return line or DEFAULT_TITLE
    cut = line[:TITLE_MAX_CHARS].rsplit(" ", 1)[0]
    return (cut or line[:TITLE_MAX_CHARS]) + "…"


async def create(db: AsyncSession, *, title: str | None = None, model_id: str | None = None) -> Conversation:
    conv = Conversation(title=title or DEFAULT_TITLE, model_id=model_id)
    db.add(conv)
    await db.flush()
    return conv


async def list_recent(db: AsyncSession, *, limit: int = 30) -> list[tuple[Conversation, int]]:
    """Most recently updated, non-archived conversations with their message counts."""
    counts = (
        select(Message.conversation_id, func.count(Message.id).label("n"))
        .group_by(Message.conversation_id)
        .subquery()
    )
    stmt = (
        select(Conversation, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.conversation_id == Conversation.id)
        .where(Conversation.archived.is_(False))
        .order_by(Conversation.updated_at.desc())
        .limit(limit)
    )
    return [(c, int(n)) for c, n in (await db.execute(stmt)).all()]


async def messages(db: AsyncSession, conversation_id: str) -> list[Message]:
    """Messages in creation order. Milestone 5 switches this to the active branch of the message tree."""
    stmt = (
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at, Message.id)
    )
    return list((await db.scalars(stmt)).all())


def to_chat_history(rows: list[Message]) -> list[ChatMessage]:
    """Messages to send to the model: completed turns plus partial replies the user stopped."""
    out: list[ChatMessage] = []
    for m in rows:
        if m.status == "error" or not m.content.strip():
            continue
        role: Role = m.role  # type: ignore[assignment]  # validated on insert
        out.append(ChatMessage(role=role, content=m.content))
    return out


async def add_message(
    db: AsyncSession,
    conv: Conversation,
    *,
    role: Role,
    content: str,
    status: str = "complete",
    model_id: str | None = None,
    parent_id: str | None = None,
) -> Message:
    msg = Message(
        conversation_id=conv.id,
        role=role,
        content=content,
        status=status,
        model_id=model_id,
        parent_id=parent_id,
    )
    db.add(msg)
    conv.updated_at = utcnow()
    await db.flush()
    return msg


async def cancel_if_streaming(sessionmaker: async_sessionmaker[AsyncSession], message_id: str) -> None:
    """Mark a reply cancelled if it never got past 'streaming' (client left before generation started)."""
    async with sessionmaker() as db:
        await db.execute(
            update(Message)
            .where(Message.id == message_id, Message.status == "streaming")
            .values(status="cancelled")
        )
        await db.commit()


async def recover_interrupted(sessionmaker: async_sessionmaker[AsyncSession]) -> int:
    """At startup: replies left 'streaming' by a crash or forced shutdown become 'cancelled'."""
    async with sessionmaker() as db:
        result = await db.execute(
            update(Message).where(Message.status == "streaming").values(status="cancelled")
        )
        await db.commit()
        return int(getattr(result, "rowcount", 0) or 0)
