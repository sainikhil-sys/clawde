"""Stopping a reply: the consumer closes the event stream mid-generation."""

from __future__ import annotations

from fastapi import FastAPI

from core.inference.gateway import InferenceGateway
from core.inference.types import ChatMessage, GenerationParams
from core.orchestrator.chat_turn import stream_turn
from services.conversation import service as conversations
from storage.database.models import Message

from .fakes import FakeProvider


async def _setup(app: FastAPI) -> str:
    async with app.state.database.sessionmaker() as db:
        conv = await conversations.create(db)
        msg = await conversations.add_message(db, conv, role="assistant", content="", status="streaming")
        await db.commit()
        return msg.id


async def test_closing_stream_saves_partial_reply_and_aborts_provider(app: FastAPI) -> None:
    provider = FakeProvider(reply=[f"t{i} " for i in range(50)], token_delay=0.01)
    gateway = InferenceGateway([provider])
    message_id = await _setup(app)

    events = stream_turn(
        sessionmaker=app.state.database.sessionmaker,
        gateway=gateway,
        model_id="fake:tiny",
        history=[ChatMessage("user", "count")],
        params=GenerationParams(),
        assistant_message_id=message_id,
        start_data={},
    )
    received = []
    async for ev in events:
        received.append(ev)
        if sum(1 for e in received if e.event == "token") == 3:
            break
    await events.aclose()  # what EventStreamResponse does when the browser disconnects

    async with app.state.database.sessionmaker() as db:
        msg = await db.get(Message, message_id)
    assert msg is not None
    assert msg.status == "cancelled"
    assert msg.content == "t0 t1 t2 "
    # The provider's generator was closed (its HTTP request aborted) and never ran to completion.
    assert provider.streams_closed == 1
    assert provider.streams_completed == 0


async def test_cancel_before_start_marks_cancelled(app: FastAPI) -> None:
    message_id = await _setup(app)
    await conversations.cancel_if_streaming(app.state.database.sessionmaker, message_id)
    async with app.state.database.sessionmaker() as db:
        msg = await db.get(Message, message_id)
    assert msg is not None and msg.status == "cancelled"


async def test_cancel_if_streaming_leaves_finished_replies_alone(app: FastAPI) -> None:
    async with app.state.database.sessionmaker() as db:
        conv = await conversations.create(db)
        msg = await conversations.add_message(db, conv, role="assistant", content="done", status="complete")
        await db.commit()
    await conversations.cancel_if_streaming(app.state.database.sessionmaker, msg.id)
    async with app.state.database.sessionmaker() as db:
        reloaded = await db.get(Message, msg.id)
    assert reloaded is not None and reloaded.status == "complete"
