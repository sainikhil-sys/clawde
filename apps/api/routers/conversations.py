from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Annotated, Any, Literal

import structlog
from fastapi import APIRouter, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.artifacts.prompt import ARTIFACT_INSTRUCTIONS
from core.inference.provider import ProviderError
from core.inference.types import GenerationParams
from core.orchestrator.chat_turn import message_payload, stream_turn
from models.registry import service as registry
from services import profiles
from services import router as auto_router
from services.artifacts import service as artifacts
from services.attachments import service as attachments
from services.audit import service as audit
from services.conversation import service as conversations
from services.conversation.context import build_turn
from services.conversation.service import MessageTree
from services.memory import service as memory
from services.settings import service as settings_service
from storage.database.base import utcnow
from storage.database.models import (
    Attachment,
    BehaviourProfile,
    Conversation,
    Folder,
    Message,
    ModelRecord,
    Project,
)

from ..deps import DatabaseDep, DbDep, GatewayDep, SettingsDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip
from ..streaming import EventStreamResponse
from .memories import MemoryOut

router = APIRouter(prefix="/conversations", tags=["conversations"])
log = structlog.get_logger("clawde.api.conversations")

MAX_MESSAGE_CHARS = 100_000
SSE_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {"content": {"text/event-stream": {}}, "description": "SSE: start, token*, done | error"}
}


# ---- Schemas ----


class ConversationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    project_id: str | None
    folder_id: str | None
    pinned: bool
    archived: bool
    model_id: str | None
    current_leaf_id: str | None
    behaviour_profile_id: str | None = None
    created_at: datetime
    updated_at: datetime


class ConversationSummary(ConversationOut):
    message_count: int


class AttachmentBrief(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    kind: str
    size_bytes: int
    status: str
    page_count: int | None
    meta: dict[str, Any]


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
    finish_reason: str | None
    created_at: datetime
    #: Ids of this message and its alternatives (edits / regenerations), oldest first.
    sibling_ids: list[str] = []
    attachments: list[AttachmentBrief] = []
    #: Saved memories that were in context for this reply (may include since-deleted ids).
    memory_ids: list[str] | None = None
    #: How the model was chosen (manual or auto, with the router's reason) and the behaviour profile used.
    route: dict[str, Any] | None = None
    #: Artifacts this reply created or updated: [{id, identifier, title, kind, version}].
    artifacts: list[dict[str, Any]] = []


class ConversationDetail(ConversationOut):
    #: The currently selected branch, root first.
    messages: list[MessageOut]


class ConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=300)
    model_id: str | None = Field(default=None, max_length=300)
    project_id: str | None = Field(default=None, max_length=32)


class ConversationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=300)
    pinned: bool | None = None
    archived: bool | None = None
    #: Explicit null removes the conversation from its folder.
    folder_id: str | None = Field(default=None, max_length=32)
    #: Explicit null removes the conversation's own profile (the project's or model's then applies).
    behaviour_profile_id: str | None = Field(default=None, max_length=32)


class SendMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    model_id: str | None = Field(default=None, max_length=300)
    params: GenerationParams | None = None
    #: Editing: the user message being replaced. The new message becomes its sibling (a new branch).
    edit_of: str | None = Field(default=None, max_length=32)
    #: Uploaded files (status "ready") to attach. When editing and omitted, the original's files are kept.
    attachment_ids: list[str] | None = Field(default=None, max_length=attachments.MAX_PER_MESSAGE)


class RegenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(max_length=32)
    model_id: str | None = Field(default=None, max_length=300)
    params: GenerationParams | None = None


class ContinueRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(max_length=32)
    params: GenerationParams | None = None


class SelectBranch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(max_length=32)


class SearchHitOut(BaseModel):
    conversation: ConversationOut
    match: Literal["title", "message"]
    snippet: str
    message_id: str | None


# ---- Helpers ----


async def _get_conversation(db: DbDep, conversation_id: str) -> Conversation:
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "conversation_not_found", "Conversation not found.")
    return conv


def _message_out(
    m: Message,
    tree: MessageTree,
    links: dict[str, list[Attachment]],
    made: dict[str, list[dict[str, Any]]],
) -> MessageOut:
    out = MessageOut.model_validate(m)
    out.sibling_ids = [s.id for s in tree.siblings(m)]
    out.attachments = [AttachmentBrief.model_validate(a) for a in links.get(m.id, [])]
    out.artifacts = made.get(m.id, [])
    return out


async def _detail(db: DbDep, conv: Conversation) -> ConversationDetail:
    path, tree = await conversations.active_path(db, conv)
    links = await attachments.links_for_messages(db, [m.id for m in path])
    made = await artifacts.refs_for_messages(db, [m.id for m in path if m.role == "assistant"])
    return ConversationDetail.model_validate(
        {
            **ConversationOut.model_validate(conv).model_dump(),
            "messages": [_message_out(m, tree, links, made) for m in path],
        }
    )


async def _resolve_attachments(db: DbDep, conv: Conversation, ids: list[str]) -> list[Attachment]:
    out: list[Attachment] = []
    for att_id in dict.fromkeys(ids):  # de-duplicate, keep order
        att = await db.get(Attachment, att_id)
        if att is None or (att.conversation_id is not None and att.conversation_id != conv.id):
            raise api_error(status.HTTP_404_NOT_FOUND, "attachment_not_found", "Attachment not found.")
        if att.status == "failed":
            raise api_error(
                status.HTTP_400_BAD_REQUEST,
                "attachment_failed",
                f"{att.filename} couldn't be read: {att.error}",
            )
        if att.status != "ready":
            raise api_error(
                status.HTTP_409_CONFLICT, "attachment_not_ready", f"{att.filename} is still being processed."
            )
        att.conversation_id = conv.id
        out.append(att)
    return out


def _get_message(tree: MessageTree, message_id: str, role: str | None = None) -> Message:
    msg = tree.by_id.get(message_id)
    if msg is None or (role is not None and msg.role != role):
        raise api_error(
            status.HTTP_404_NOT_FOUND, "message_not_found", "Message not found in this conversation."
        )
    return msg


async def _resolve_model(
    db: DbDep,
    gateway: GatewayDep,
    requested: str | None,
    conv: Conversation,
    *,
    text: str = "",
    has_images: bool = False,
    has_documents: bool = False,
) -> tuple[ModelRecord, dict[str, Any]]:
    """The model to use and how it was chosen. `auto` (requested, or the chat's setting) asks the router."""
    model_id = requested or conv.model_id or (await settings_service.load(db)).default_model
    if model_id == auto_router.AUTO:
        await registry.sync(db, gateway)
        try:
            decision = await auto_router.decide(
                db, gateway, text=text, has_images=has_images, has_documents=has_documents
            )
        except auto_router.NoModel as exc:
            raise api_error(status.HTTP_400_BAD_REQUEST, "no_model_selected", str(exc)) from exc
        rec = await db.get(ModelRecord, decision.model_id)
        assert rec is not None
        return rec, decision.as_route()
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
    return rec, {"mode": "manual", "model_id": rec.id}


def _ensure_idle(request: Request, conv: Conversation) -> set[str]:
    active: set[str] = request.app.state.active_generations
    if conv.id in active:
        raise api_error(
            status.HTTP_409_CONFLICT, "generation_in_progress", "A reply is already being generated."
        )
    return active


async def _start_stream(
    *,
    request: Request,
    db: DbDep,
    settings: SettingsDep,
    database: DatabaseDep,
    gateway: GatewayDep,
    conv: Conversation,
    model: ModelRecord,
    params: GenerationParams | None,
    history_rows: list[Message],
    assistant: Message,
    user_message: Message | None,
    initial_content: str = "",
    route: dict[str, Any] | None = None,
) -> EventStreamResponse:
    """Common tail of send / regenerate / continue: fit history and stream into `assistant`."""
    active: set[str] = request.app.state.active_generations
    project = await db.get(Project, conv.project_id) if conv.project_id else None
    profile = await profiles.effective(db, conversation=conv, project=project, model=model)
    # Settings sent with the message win; otherwise the profile's defaults over the app's.
    params = params or profiles.apply_params(GenerationParams(), profile.profile if profile else None)
    if model.context_length:
        params = params.model_copy(
            update={"context_length": min(params.context_length, model.context_length)}
        )
    prefs = await settings_service.load(db)
    if prefs.keep_one_model_loaded:
        unloaded = await auto_router.keep_one_loaded(gateway, model.id)
        if unloaded:
            log.info("models.unloaded_others", kept=model.id, unloaded=unloaded)
    preamble = "\n\n".join(
        t
        for t in (profiles.instructions(profile), ARTIFACT_INSTRUCTIONS if prefs.artifacts_enabled else "")
        if t
    )
    turn = await build_turn(
        db,
        gateway,
        settings.uploads_dir,
        history_rows,
        model,
        params,
        project=project,
        indexes_dir=settings.indexes_dir,
        conversation=conv,
        use_memory=prefs.memory_enabled,
        preamble=preamble,
    )
    assistant.memory_ids = turn.memory_ids or None
    assistant.route = {
        **(route or {"mode": "manual", "model_id": model.id}),
        "profile": {"id": profile.profile.id, "name": profile.profile.name, "source": profile.source}
        if profile
        else None,
    }
    model.last_used_at = utcnow()
    await db.commit()
    start: dict[str, Any] = {
        "conversation": ConversationOut.model_validate(conv).model_dump(mode="json"),
        "user_message": message_payload(user_message) if user_message else None,
        "assistant_message": message_payload(assistant),
        "history_messages_dropped": turn.dropped,
        "documents": turn.documents,
        "memory": turn.memory,
    }
    assistant_id = assistant.id
    conv_id = conv.id
    auto_summarise = prefs.memory_auto_summarise and turn.dropped > 0

    async def on_close() -> None:
        active.discard(conv_id)
        await conversations.cancel_if_streaming(database.sessionmaker, assistant_id)
        if auto_summarise:
            schedule_summary(request, database, gateway, conv_id, model.id, params.context_length)

    active.add(conv.id)
    events = stream_turn(
        sessionmaker=database.sessionmaker,
        gateway=gateway,
        model_id=model.id,
        history=turn.history,
        params=params,
        assistant_message_id=assistant_id,
        start_data=start,
        initial_content=initial_content,
        on_complete=_extract_artifacts,
    )
    return EventStreamResponse(events, on_close=on_close)


async def _extract_artifacts(db: AsyncSession, msg: Message) -> dict[str, Any]:
    refs = await artifacts.extract_from_message(db, msg)
    return {"artifacts": [r.as_dict() for r in refs]}


def schedule_summary(
    request: Request,
    database: DatabaseDep,
    gateway: GatewayDep,
    conversation_id: str,
    model_id: str,
    context_length: int,
) -> None:
    """Refresh the conversation's summary in the background once its history overflows the context window."""
    busy: set[str] = request.app.state.summarising
    if conversation_id in busy:
        return
    busy.add(conversation_id)

    async def run() -> None:
        try:
            async with database.sessionmaker() as db:
                conv = await db.get(Conversation, conversation_id)
                rec = await db.get(ModelRecord, model_id)
                if conv is None or rec is None or not await memory.needs_summary(db, conv):
                    return
                await memory.summarise(db, gateway, conv, rec, context_length=context_length)
                await db.commit()
                log.info("memory.auto_summarised", conversation_id=conversation_id)
        except (ProviderError, memory.MemoryError) as exc:
            log.warning("memory.auto_summary_failed", conversation_id=conversation_id, error=str(exc))
        finally:
            busy.discard(conversation_id)

    tasks: set[asyncio.Task[None]] = request.app.state.background_tasks
    task = asyncio.create_task(run())
    tasks.add(task)
    task.add_done_callback(tasks.discard)


class SummariseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model_id: str | None = Field(default=None, max_length=300)
    context_length: int = Field(default=8192, ge=512, le=131_072)


@router.post("/{conversation_id}/summarise", response_model=MemoryOut)
async def summarise_conversation(
    conversation_id: str,
    body: SummariseRequest,
    request: Request,
    _: CsrfSessionDep,
    db: DbDep,
    gateway: GatewayDep,
) -> MemoryOut:
    """Summarise the current branch with a model and save it as this conversation's summary memory
    (replacing the previous one)."""
    conv = await _get_conversation(db, conversation_id)
    model, _route = await _resolve_model(db, gateway, body.model_id, conv)
    try:
        mem = await memory.summarise(db, gateway, conv, model, context_length=body.context_length)
    except memory.MemoryError as exc:
        raise api_error(exc.status, exc.code, exc.message) from exc
    except ProviderError as exc:
        raise api_error(status.HTTP_502_BAD_GATEWAY, exc.code, str(exc)) from exc
    await audit.record(
        db,
        "memory.summarise",
        target_type="conversation",
        target_id=conv.id,
        details={"memory_id": mem.id, "model_id": model.id},
        client_ip=client_ip(request),
    )
    await db.commit()
    await db.refresh(mem)
    return MemoryOut.model_validate(mem).model_copy(update={"conversation_title": conv.title})


# ---- Listing, search, CRUD ----


@router.get("", response_model=list[ConversationSummary])
async def list_conversations(
    _: SessionDep,
    db: DbDep,
    archived: bool = False,
    folder_id: Annotated[str | None, Query(max_length=32)] = None,
    pinned: bool | None = None,
    project_id: Annotated[str | None, Query(max_length=32)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 30,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[ConversationSummary]:
    rows = await conversations.list_conversations(
        db,
        archived=archived,
        folder_id=folder_id,
        pinned=pinned,
        project_id=project_id,
        limit=limit,
        offset=offset,
    )
    return [
        ConversationSummary.model_validate(
            {**ConversationOut.model_validate(c).model_dump(), "message_count": n}
        )
        for c, n in rows
    ]


@router.get("/search", response_model=list[SearchHitOut])
async def search_conversations(
    _: SessionDep,
    db: DbDep,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[SearchHitOut]:
    hits = await conversations.search(db, q, limit=limit)
    return [
        SearchHitOut(
            conversation=ConversationOut.model_validate(h.conversation),
            match=h.match,
            snippet=h.snippet,
            message_id=h.message_id,
        )
        for h in hits
    ]


@router.post("", response_model=ConversationOut, status_code=status.HTTP_201_CREATED)
async def create_conversation(body: ConversationCreate, _: CsrfSessionDep, db: DbDep) -> ConversationOut:
    if body.project_id is not None:
        project = await db.get(Project, body.project_id)
        if project is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "project_not_found", "Project not found.")
        if project.archived_at is not None:
            raise api_error(
                status.HTTP_409_CONFLICT, "project_archived", "Unarchive the project to start new chats."
            )
    conv = await conversations.create(
        db, title=body.title, model_id=body.model_id, project_id=body.project_id
    )
    await db.commit()
    return ConversationOut.model_validate(conv)


@router.get("/{conversation_id}", response_model=ConversationDetail)
async def get_conversation(conversation_id: str, _: SessionDep, db: DbDep) -> ConversationDetail:
    return await _detail(db, await _get_conversation(db, conversation_id))


@router.patch("/{conversation_id}", response_model=ConversationOut)
async def update_conversation(
    conversation_id: str, body: ConversationPatch, _: CsrfSessionDep, db: DbDep
) -> ConversationOut:
    conv = await _get_conversation(db, conversation_id)
    fields = body.model_fields_set
    if "title" in fields and body.title is not None:
        conv.title = body.title.strip() or conv.title
    if "pinned" in fields and body.pinned is not None:
        conv.pinned = body.pinned
    if "archived" in fields and body.archived is not None:
        conv.archived = body.archived
    if "folder_id" in fields:
        if body.folder_id is not None and await db.get(Folder, body.folder_id) is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "folder_not_found", "Folder not found.")
        conv.folder_id = body.folder_id
    if "behaviour_profile_id" in fields:
        if (
            body.behaviour_profile_id is not None
            and await db.get(BehaviourProfile, body.behaviour_profile_id) is None
        ):
            raise api_error(status.HTTP_404_NOT_FOUND, "profile_not_found", "Behaviour profile not found.")
        conv.behaviour_profile_id = body.behaviour_profile_id
    await db.commit()
    await db.refresh(conv)
    return ConversationOut.model_validate(conv)


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    conversation_id: str, request: Request, _: CsrfSessionDep, db: DbDep, settings: SettingsDep
) -> None:
    conv = await _get_conversation(db, conversation_id)
    _ensure_idle(request, conv)
    count = len((await conversations.load_tree(db, conv.id)).by_id)
    file_ids = list(
        (await db.scalars(select(Attachment.id).where(Attachment.conversation_id == conv.id))).all()
    )
    await db.delete(conv)
    await audit.record(
        db,
        "conversation.delete",
        target_type="conversation",
        target_id=conversation_id,
        details={"messages": count, "files": len(file_ids)},
        client_ip=client_ip(request),
    )
    await db.commit()
    for file_id in file_ids:
        attachments.remove_files(settings.uploads_dir, file_id)


@router.get("/{conversation_id}/export")
async def export_conversation(
    conversation_id: str,
    _: SessionDep,
    db: DbDep,
    format: Annotated[Literal["markdown", "json"], Query()] = "markdown",
) -> Response:
    conv = await _get_conversation(db, conversation_id)
    path, tree = await conversations.active_path(db, conv)
    if format == "json":
        body, media, ext = conversations.export_json(conv, tree, path), "application/json", "json"
    else:
        body, media, ext = conversations.export_markdown(conv, path), "text/markdown", "md"
    filename = conversations.export_filename(conv, ext)
    return Response(
        content=body.encode("utf-8"),
        media_type=f"{media}; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.put("/{conversation_id}/branch", response_model=ConversationDetail)
async def select_branch(
    conversation_id: str, body: SelectBranch, request: Request, _: CsrfSessionDep, db: DbDep
) -> ConversationDetail:
    """Show the branch containing `message_id` (continuing down its most recent replies)."""
    conv = await _get_conversation(db, conversation_id)
    _ensure_idle(request, conv)
    tree = await conversations.load_tree(db, conv.id)
    msg = _get_message(tree, body.message_id)
    conv.current_leaf_id = tree.deepest_leaf(msg).id
    await db.commit()
    return await _detail(db, conv)


# ---- Generation ----


@router.post("/{conversation_id}/messages", response_class=EventStreamResponse, responses=SSE_RESPONSES)
async def send_message(
    conversation_id: str,
    body: SendMessage,
    request: Request,
    _: CsrfSessionDep,
    db: DbDep,
    database: DatabaseDep,
    gateway: GatewayDep,
    settings: SettingsDep,
) -> EventStreamResponse:
    """Adds a user message (or an edited version of one) and streams the reply. Disconnecting stops it."""
    conv = await _get_conversation(db, conversation_id)
    _ensure_idle(request, conv)
    has_files = bool(body.attachment_ids)
    has_images = has_files and any(
        a.kind == "image" for a in [await db.get(Attachment, i) for i in body.attachment_ids or []] if a
    )
    model, route = await _resolve_model(
        db,
        gateway,
        body.model_id,
        conv,
        text=body.content,
        has_images=has_images,
        has_documents=has_files and not has_images,
    )

    path, tree = await conversations.active_path(db, conv)
    edited: Message | None = None
    if body.edit_of is not None:
        edited = _get_message(tree, body.edit_of, role="user")
        parent_id = edited.parent_id
        prior = tree.path_to(tree.by_id.get(parent_id)) if parent_id else []
    else:
        prior = path
        parent_id = path[-1].id if path else None

    if not tree.by_id and conv.title == conversations.DEFAULT_TITLE:
        conv.title = conversations.title_from_text(body.content)
    # Remember the choice: "auto" stays auto (each message is routed), otherwise the chosen model.
    conv.model_id = auto_router.AUTO if route["mode"] == "auto" else model.id
    if body.attachment_ids is not None:
        files = await _resolve_attachments(db, conv, body.attachment_ids)
    elif edited is not None:
        files = (await attachments.links_for_messages(db, [edited.id])).get(edited.id, [])
    else:
        files = []
    user_msg = await conversations.add_message(
        db, conv, role="user", content=body.content, parent_id=parent_id
    )
    await attachments.link(db, user_msg.id, files)
    assistant = await conversations.add_message(
        db, conv, role="assistant", content="", status="streaming", model_id=model.id, parent_id=user_msg.id
    )
    await db.commit()
    return await _start_stream(
        request=request,
        db=db,
        settings=settings,
        database=database,
        gateway=gateway,
        conv=conv,
        model=model,
        params=body.params,
        history_rows=[*prior, user_msg],
        assistant=assistant,
        user_message=user_msg,
        route=route,
    )


@router.post("/{conversation_id}/regenerate", response_class=EventStreamResponse, responses=SSE_RESPONSES)
async def regenerate(
    conversation_id: str,
    body: RegenerateRequest,
    request: Request,
    _: CsrfSessionDep,
    db: DbDep,
    database: DatabaseDep,
    gateway: GatewayDep,
    settings: SettingsDep,
) -> EventStreamResponse:
    """New reply to the same prompt, kept as an alternative to the old one. Also used to retry errors."""
    conv = await _get_conversation(db, conversation_id)
    _ensure_idle(request, conv)
    tree = await conversations.load_tree(db, conv.id)
    old = _get_message(tree, body.message_id, role="assistant")
    parent = tree.by_id.get(old.parent_id) if old.parent_id else None
    if parent is None:
        raise api_error(
            status.HTTP_400_BAD_REQUEST, "nothing_to_regenerate", "This reply has no prompt to answer."
        )
    model, route = await _resolve_model(db, gateway, body.model_id, conv, text=parent.content)
    conv.model_id = auto_router.AUTO if route["mode"] == "auto" else model.id
    assistant = await conversations.add_message(
        db, conv, role="assistant", content="", status="streaming", model_id=model.id, parent_id=parent.id
    )
    await db.commit()
    return await _start_stream(
        request=request,
        db=db,
        settings=settings,
        database=database,
        gateway=gateway,
        conv=conv,
        model=model,
        params=body.params,
        history_rows=tree.path_to(parent),
        assistant=assistant,
        user_message=None,
        route=route,
    )


@router.post("/{conversation_id}/continue", response_class=EventStreamResponse, responses=SSE_RESPONSES)
async def continue_reply(
    conversation_id: str,
    body: ContinueRequest,
    request: Request,
    _: CsrfSessionDep,
    db: DbDep,
    database: DatabaseDep,
    gateway: GatewayDep,
    settings: SettingsDep,
) -> EventStreamResponse:
    """Resume a reply that was stopped or hit the token limit, appending to the same message."""
    conv = await _get_conversation(db, conversation_id)
    _ensure_idle(request, conv)
    tree = await conversations.load_tree(db, conv.id)
    msg = _get_message(tree, body.message_id, role="assistant")
    if not msg.content.strip() or msg.status not in ("cancelled", "complete", "error"):
        raise api_error(
            status.HTTP_400_BAD_REQUEST, "cannot_continue", "Only a reply with some text can be continued."
        )
    if msg.status == "complete" and msg.finish_reason != "length":
        raise api_error(status.HTTP_400_BAD_REQUEST, "cannot_continue", "This reply already finished.")
    if tree.children.get(msg.id):
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            "cannot_continue",
            "Only the last reply in a branch can be continued.",
        )
    model, route = await _resolve_model(db, gateway, msg.model_id, conv)
    initial = msg.content
    msg.status = "streaming"
    msg.error = None
    conv.current_leaf_id = msg.id
    await db.commit()
    return await _start_stream(
        request=request,
        db=db,
        settings=settings,
        database=database,
        gateway=gateway,
        conv=conv,
        model=model,
        params=body.params,
        # The partial reply is sent as the last message; the model continues from it.
        history_rows=tree.path_to(msg),
        assistant=msg,
        user_message=None,
        initial_content=initial,
        route=msg.route or route,
    )
