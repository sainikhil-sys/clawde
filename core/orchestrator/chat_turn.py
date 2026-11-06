"""One assistant turn: stream tokens from a model, forward them as events, and persist the outcome.

FastAPI-free so it can be driven by the SSE endpoint, agents (M10) or tests alike.

Outcome rules:
- finished normally  → message status "complete" with token counts
- provider failure   → status "error" with the error text (partial text kept)
- consumer went away → status "cancelled" with whatever text was generated (the user pressed Stop)
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncGenerator, Sequence
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any

import anyio
import structlog
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.inference.gateway import InferenceGateway
from core.inference.provider import ProviderError
from core.inference.types import ChatMessage, GenerationDone, GenerationParams, TokenDelta
from storage.database.base import utcnow
from storage.database.models import Conversation, Message

log = structlog.get_logger("clawde.orchestrator")


@dataclass(frozen=True, slots=True)
class TurnEvent:
    event: str  # start | token | done | error
    data: dict[str, Any]

    def encode(self) -> bytes:
        """Server-Sent Events wire format."""
        return f"event: {self.event}\ndata: {json.dumps(self.data, separators=(',', ':'))}\n\n".encode()


def message_payload(m: Message) -> dict[str, Any]:
    return {
        "id": m.id,
        "conversation_id": m.conversation_id,
        "parent_id": m.parent_id,
        "role": m.role,
        "content": m.content,
        "status": m.status,
        "model_id": m.model_id,
        "prompt_tokens": m.prompt_tokens,
        "completion_tokens": m.completion_tokens,
        "error": m.error,
        "created_at": m.created_at.isoformat(),
    }


async def stream_turn(
    *,
    sessionmaker: async_sessionmaker[AsyncSession],
    gateway: InferenceGateway,
    model_id: str,
    history: Sequence[ChatMessage],
    params: GenerationParams,
    assistant_message_id: str,
    start_data: dict[str, Any],
) -> AsyncGenerator[TurnEvent]:
    parts: list[str] = []
    done: GenerationDone | None = None
    error: ProviderError | None = None
    status = "cancelled"  # overwritten unless the consumer stops iterating early
    started = time.perf_counter()
    first_token_at: float | None = None

    try:
        yield TurnEvent("start", start_data)
        async with aclosing(gateway.chat_stream(model_id, history, params)) as stream:
            async for ev in stream:
                if isinstance(ev, TokenDelta):
                    if first_token_at is None:
                        first_token_at = time.perf_counter()
                    parts.append(ev.text)
                    yield TurnEvent("token", {"text": ev.text})
                elif isinstance(ev, GenerationDone):
                    done = ev
        status = "complete"
    except ProviderError as exc:
        status, error = "error", exc
    except Exception as exc:  # unexpected bug: record it, don't leak internals to the client
        log.exception("turn.unexpected_error", model_id=model_id)
        status, error = "error", ProviderError(f"Unexpected error: {type(exc).__name__}")
    finally:
        # Must complete even when the request was cancelled (client disconnected).
        with anyio.CancelScope(shield=True):
            saved = await _persist(sessionmaker, assistant_message_id, "".join(parts), status, done, error)
        log.info(
            "turn.finished",
            model_id=model_id,
            status=status,
            completion_chars=sum(len(p) for p in parts),
            first_token_ms=round((first_token_at - started) * 1000) if first_token_at else None,
            total_ms=round((time.perf_counter() - started) * 1000),
        )

    if status == "complete" and saved is not None:
        yield TurnEvent(
            "done",
            {
                "message": message_payload(saved),
                "finish_reason": done.finish_reason if done else "stop",
                "total_duration_ms": done.total_duration_ms if done else None,
                "load_duration_ms": done.load_duration_ms if done else None,
            },
        )
    elif status == "error" and error is not None:
        yield TurnEvent(
            "error",
            {"code": error.code, "message": error.message, "message_id": assistant_message_id},
        )


async def _persist(
    sessionmaker: async_sessionmaker[AsyncSession],
    message_id: str,
    content: str,
    status: str,
    done: GenerationDone | None,
    error: ProviderError | None,
) -> Message | None:
    try:
        async with sessionmaker() as db:
            msg = await db.get(Message, message_id)
            if msg is None:
                return None
            msg.content = content
            msg.status = status
            msg.error = error.message if error else None
            if done is not None:
                msg.prompt_tokens = done.prompt_tokens
                msg.completion_tokens = done.completion_tokens
            conv = await db.get(Conversation, msg.conversation_id)
            if conv is not None:
                conv.updated_at = utcnow()
            await db.commit()
            await db.refresh(msg)
            return msg
    except Exception:
        log.exception("turn.persist_failed", message_id=message_id)
        return None
