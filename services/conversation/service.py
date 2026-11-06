"""Conversations, the message tree, search and export.

Messages form a tree through `parent_id`: editing a user message or regenerating a reply adds a sibling
instead of overwriting. `Conversation.current_leaf_id` marks the branch currently shown; the "active path" is
the chain from that leaf back to the root.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import Select, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.inference.types import ChatMessage, Role
from storage.database.base import utcnow
from storage.database.models import Conversation, Message

TITLE_MAX_CHARS = 60
DEFAULT_TITLE = "New conversation"
SNIPPET_RADIUS = 60


def title_from_text(text: str) -> str:
    """First line of the first message, trimmed at a word boundary."""
    line = " ".join(text.strip().split())
    if len(line) <= TITLE_MAX_CHARS:
        return line or DEFAULT_TITLE
    cut = line[:TITLE_MAX_CHARS].rsplit(" ", 1)[0]
    return (cut or line[:TITLE_MAX_CHARS]) + "…"


async def create(
    db: AsyncSession, *, title: str | None = None, model_id: str | None = None, project_id: str | None = None
) -> Conversation:
    conv = Conversation(title=title or DEFAULT_TITLE, model_id=model_id, project_id=project_id)
    db.add(conv)
    await db.flush()
    return conv


def _with_counts(stmt: Select[Any]) -> Select[Any]:
    counts = (
        select(Message.conversation_id, func.count(Message.id).label("n"))
        .group_by(Message.conversation_id)
        .subquery()
    )
    return stmt.add_columns(func.coalesce(counts.c.n, 0)).outerjoin(
        counts, counts.c.conversation_id == Conversation.id
    )


async def list_conversations(
    db: AsyncSession,
    *,
    archived: bool = False,
    folder_id: str | None = None,
    pinned: bool | None = None,
    project_id: str | None = None,
    limit: int = 30,
    offset: int = 0,
) -> list[tuple[Conversation, int]]:
    """Pinned first, then most recently updated."""
    stmt = select(Conversation).where(Conversation.archived.is_(archived))
    if project_id is not None:
        stmt = stmt.where(Conversation.project_id == project_id)
    if folder_id is not None:
        stmt = stmt.where(Conversation.folder_id == folder_id)
    if pinned is not None:
        stmt = stmt.where(Conversation.pinned.is_(pinned))
    stmt = (
        stmt.order_by(Conversation.pinned.desc(), Conversation.updated_at.desc()).limit(limit).offset(offset)
    )
    return [(c, int(n)) for c, n in (await db.execute(_with_counts(stmt))).all()]


# ---- Search ----


@dataclass(frozen=True, slots=True)
class SearchHit:
    conversation: Conversation
    match: Literal["title", "message"]
    snippet: str
    message_id: str | None


def _like_pattern(q: str) -> str:
    escaped = q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def make_snippet(text: str, query: str) -> str:
    flat = " ".join(text.split())
    idx = flat.lower().find(query.lower())
    if idx < 0:
        return flat[: SNIPPET_RADIUS * 2]
    start = max(0, idx - SNIPPET_RADIUS)
    end = min(len(flat), idx + len(query) + SNIPPET_RADIUS)
    return ("…" if start else "") + flat[start:end] + ("…" if end < len(flat) else "")


async def search(db: AsyncSession, query: str, *, limit: int = 20) -> list[SearchHit]:
    """Case-insensitive substring search over titles and message text (all branches, incl. archived).

    Plain LIKE keeps this portable across SQLite and PostgreSQL; an indexed full-text search can replace
    it if history grows large.
    """
    q = query.strip()
    if not q:
        return []
    pattern = _like_pattern(q)
    hits: dict[str, SearchHit] = {}

    title_rows = await db.scalars(
        select(Conversation)
        .where(func.lower(Conversation.title).like(pattern, escape="\\"))
        .order_by(Conversation.updated_at.desc())
        .limit(limit)
    )
    for conv in title_rows:
        hits[conv.id] = SearchHit(conv, "title", conv.title, None)

    if len(hits) < limit:
        msg_rows = await db.execute(
            select(Message, Conversation)
            .join(Conversation, Conversation.id == Message.conversation_id)
            .where(func.lower(Message.content).like(pattern, escape="\\"))
            .order_by(Conversation.updated_at.desc(), Message.created_at.desc())
            .limit(limit * 5)
        )
        for msg, conv in msg_rows.all():
            if conv.id in hits:
                continue
            hits[conv.id] = SearchHit(conv, "message", make_snippet(msg.content, q), msg.id)
            if len(hits) >= limit:
                break
    return list(hits.values())[:limit]


# ---- Message tree ----


@dataclass(slots=True)
class MessageTree:
    by_id: dict[str, Message]
    children: dict[str | None, list[Message]]

    def siblings(self, msg: Message) -> list[Message]:
        return self.children.get(msg.parent_id, [msg])

    def deepest_leaf(self, msg: Message) -> Message:
        """Follow the most recent child until the end of the branch."""
        current = msg
        while kids := self.children.get(current.id):
            current = kids[-1]
        return current

    def path_to(self, msg: Message | None) -> list[Message]:
        path: list[Message] = []
        seen: set[str] = set()
        while msg is not None and msg.id not in seen:
            seen.add(msg.id)
            path.append(msg)
            msg = self.by_id.get(msg.parent_id) if msg.parent_id else None
        path.reverse()
        return path


async def load_tree(db: AsyncSession, conversation_id: str) -> MessageTree:
    rows = (
        await db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at, Message.id)
        )
    ).all()
    children: dict[str | None, list[Message]] = defaultdict(list)
    for m in rows:
        children[m.parent_id].append(m)
    return MessageTree({m.id: m for m in rows}, dict(children))


def active_leaf(conv: Conversation, tree: MessageTree) -> Message | None:
    leaf = tree.by_id.get(conv.current_leaf_id) if conv.current_leaf_id else None
    if leaf is None and tree.by_id:
        # Missing or stale pointer: fall back to the newest message.
        leaf = max(tree.by_id.values(), key=lambda m: (m.created_at, m.id))
    return leaf


async def active_path(db: AsyncSession, conv: Conversation) -> tuple[list[Message], MessageTree]:
    tree = await load_tree(db, conv.id)
    return tree.path_to(active_leaf(conv, tree)), tree


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
    """Adds a message and makes it the end of the active branch."""
    msg = Message(
        conversation_id=conv.id,
        role=role,
        content=content,
        status=status,
        model_id=model_id,
        parent_id=parent_id,
    )
    db.add(msg)
    await db.flush()
    conv.current_leaf_id = msg.id
    conv.updated_at = utcnow()
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


# ---- Export ----


def export_filename(conv: Conversation, ext: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", conv.title.lower()).strip("-")[:50] or "conversation"
    return f"{slug}-{conv.created_at:%Y%m%d}.{ext}"


def export_markdown(conv: Conversation, path: list[Message]) -> str:
    lines = [
        f"# {conv.title}",
        "",
        f"_Exported from Clawde on {datetime.now(UTC):%Y-%m-%d %H:%M} UTC. "
        "Shows the currently selected branch._",
        "",
    ]
    for m in path:
        who = "You" if m.role == "user" else ("Assistant" if m.role == "assistant" else m.role.capitalize())
        meta = [f"{m.created_at:%Y-%m-%d %H:%M} UTC"]
        if m.model_id:
            meta.append(m.model_id)
        if m.status in ("cancelled", "error"):
            meta.append("stopped" if m.status == "cancelled" else f"error: {m.error}")
        lines += [f"## {who}", f"<sub>{' · '.join(meta)}</sub>", "", m.content, ""]
    return "\n".join(lines).rstrip() + "\n"


def export_json(conv: Conversation, tree: MessageTree, path: list[Message]) -> str:
    def msg(m: Message) -> dict[str, Any]:
        return {
            "id": m.id,
            "parent_id": m.parent_id,
            "role": m.role,
            "content": m.content,
            "status": m.status,
            "model_id": m.model_id,
            "finish_reason": m.finish_reason,
            "prompt_tokens": m.prompt_tokens,
            "completion_tokens": m.completion_tokens,
            "error": m.error,
            "created_at": m.created_at.isoformat(),
        }

    doc = {
        "format": "clawde.conversation.v1",
        "exported_at": datetime.now(UTC).isoformat(),
        "conversation": {
            "id": conv.id,
            "title": conv.title,
            "model_id": conv.model_id,
            "pinned": conv.pinned,
            "archived": conv.archived,
            "created_at": conv.created_at.isoformat(),
            "updated_at": conv.updated_at.isoformat(),
        },
        "active_path": [m.id for m in path],
        "messages": [msg(m) for m in sorted(tree.by_id.values(), key=lambda m: (m.created_at, m.id))],
    }
    return json.dumps(doc, ensure_ascii=False, indent=2)
