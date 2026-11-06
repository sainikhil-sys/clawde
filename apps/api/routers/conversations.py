from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from core.context.budget import fit_history
from core.inference.types import GenerationParams
from core.orchestrator.chat_turn import message_payload, stream_turn
from models.registry import service as registry
from services.conversation import service as conversations
from services.settings import service as settings_service
from storage.database.models import Conversation, ModelRecord

from ..deps import DatabaseDep, DbDep, GatewayDep
from ..security import CsrfSessionDep, SessionDep, api_error
from ..streaming import EventStreamResponse

router = APIRouter(prefix="/conversations", tags=["conversations"])

MAX_MESSAGE_CHARS = 100_000


class ConversationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    project_id: str | None
    folder_id: str | None
    pinned: bool
    archived: bool
    model_id: str | None
    created_at: datetime
    updated_at: datetime


class ConversationSummary(ConversationOut):
    message_count: int


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    conversation_id: str
    parent_id: str | None
    role: str
    content: str
    status: str
    model_id: str | None
    prompt_tokens: int | None
    completion_tokens: int | None
    error: str | None
    created_at: datetime


class ConversationDetail(ConversationOut):
    messages: list[MessageOut]


class ConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=300)
    model_id: str | None = Field(default=None, max_length=300)


class SendMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    model_id: str | None = Field(default=None, max_length=300)
    params: GenerationParams = Field(default_factory=GenerationParams)


async def _get_conversation(db: DbDep, conversation_id: str) -> Conversation:
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "conversation_not_found", "Conversation not found.")
    return conv


@router.get("", response_model=list[ConversationSummary])
async def list_conversations(
    _: SessionDep, db: DbDep, limit: Annotated[int, Query(ge=1, le=200)] = 30
) -> list[ConversationSummary]:
    rows = await conversations.list_recent(db, limit=limit)
    return [
        ConversationSummary.model_validate(
            {**ConversationOut.model_validate(c).model_dump(), "message_count": n}
        )
        for c, n in rows
    ]


@router.post("", response_model=ConversationOut, status_code=status.HTTP_201_CREATED)
async def create_conversation(body: ConversationCreate, _: CsrfSessionDep, db: DbDep) -> ConversationOut:
    conv = await conversations.create(db, title=body.title, model_id=body.model_id)
    await db.commit()
    return ConversationOut.model_validate(conv)


@router.get("/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(conversation_id: str, _: SessionDep, db: DbDep) -> ConversationDetail:
    conv = await _get_conversation(db, conversation_id)
    msgs = await conversations.messages(db, conv.id)
    return ConversationDetail.model_validate(
        {
            **ConversationOut.model_validate(conv).model_dump(),
            "messages": [MessageOut.model_validate(m) for m in msgs],
        }
    )


async def _resolve_model(
    db: DbDep, gateway: GatewayDep, requested: str | None, conv: Conversation
) -> ModelRecord:
    model_id = requested or conv.model_id or (await settings_service.load(db)).default_model
    if not model_id:
        raise api_error(status.HTTP_400_BAD_REQUEST, "no_model_selected", "Choose a model to chat with.")
    rec = await db.get(ModelRecord, model_id)
    if rec is None or not rec.available:
        # The model may have been installed since the last sync.
        await registry.sync(db, gateway)
        rec = await db.get(ModelRecord, model_id)
    if rec is None or not rec.available:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            "model_unavailable",
            f"Model {model_id!r} is not available. Is its provider running and the model installed?",
        )
    if not registry.is_chat_model(rec):
        raise api_error(
            status.HTTP_400_BAD_REQUEST, "model_not_chat", f"Model {model_id!r} does not support chat."
        )
    return rec


@router.post(
    "/{conversation_id}/messages",
    response_class=EventStreamResponse,
    responses={
        200: {"content": {"text/event-stream": {}}, "description": "SSE: start, token*, done | error"}
    },
)
async def send_message(
    conversation_id: str,
    body: SendMessage,
    request: Request,
    _: CsrfSessionDep,
    db: DbDep,
    database: DatabaseDep,
    gateway: GatewayDep,
) -> EventStreamResponse:
    """Adds the user message and streams the assistant reply. Disconnecting stops generation."""
    conv = await _get_conversation(db, conversation_id)
    model = await _resolve_model(db, gateway, body.model_id, conv)

    active: set[str] = request.app.state.active_generations
    if conv.id in active:
        raise api_error(
            status.HTTP_409_CONFLICT, "generation_in_progress", "A reply is already being generated."
        )

    prior = await conversations.messages(db, conv.id)
    parent_id = prior[-1].id if prior else None
    if not prior and conv.title == conversations.DEFAULT_TITLE:
        conv.title = conversations.title_from_text(body.content)
    conv.model_id = model.id
    user_msg = await conversations.add_message(
        db, conv, role="user", content=body.content, parent_id=parent_id
    )
    assistant = await conversations.add_message(
        db, conv, role="assistant", content="", status="streaming", model_id=model.id, parent_id=user_msg.id
    )
    await db.commit()

    params = body.params
    if model.context_length:
        params = params.model_copy(
            update={"context_length": min(params.context_length, model.context_length)}
        )
    history, dropped = fit_history(
        conversations.to_chat_history([*prior, user_msg]),
        context_length=params.context_length,
        reserve_for_output=params.max_tokens,
    )
    start: dict[str, Any] = {
        "conversation": ConversationOut.model_validate(conv).model_dump(mode="json"),
        "user_message": message_payload(user_msg),
        "assistant_message": message_payload(assistant),
        "history_messages_dropped": dropped,
    }

    assistant_id = assistant.id

    async def on_close() -> None:
        active.discard(conv.id)
        await conversations.cancel_if_streaming(database.sessionmaker, assistant_id)

    active.add(conv.id)
    events = stream_turn(
        sessionmaker=database.sessionmaker,
        gateway=gateway,
        model_id=model.id,
        history=history,
        params=params,
        assistant_message_id=assistant.id,
        start_data=start,
    )
    return EventStreamResponse(events, on_close=on_close)
