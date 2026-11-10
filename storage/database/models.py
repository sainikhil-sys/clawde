"""ORM models. M3: sessions, audit log, settings, conversation core. M4: model registry.
M5: active branch pointer, finish reasons, prompt templates. M6: attachments and document chunks.
M7: project knowledge (attachments.project_id). M8: memories, messages.memory_ids.
M9: artifacts and versions. M10: agent runs and steps. M11: model metadata, behaviour profiles, routing
records, evaluation runs and results.

Later milestones add their tables through new Alembic revisions (see docs/02-architecture.md §5).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, BigInteger, Boolean, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base, new_id, utcnow


class AppSession(Base):
    """Browser session for the single local user. Only a SHA-256 hash of the cookie token is stored."""

    __tablename__ = "app_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 hex of the cookie token
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(index=True)
    user_agent: Mapped[str | None] = mapped_column(String(300))


class AuditEvent(Base):
    """Append-only record of security-relevant actions. Never store secrets in `details`."""

    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(100))  # "user", "system", later "agent:<run id>"
    action: Mapped[str] = mapped_column(String(100), index=True)  # e.g. "session.create"
    target_type: Mapped[str | None] = mapped_column(String(50))
    target_id: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    client_ip: Mapped[str | None] = mapped_column(String(45))


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class Folder(Base):
    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    instructions: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    archived_at: Mapped[datetime | None] = mapped_column()
    behaviour_profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("behaviour_profiles.id", ondelete="SET NULL"), index=True
    )


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(300), default="New conversation")
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    folder_id: Mapped[str | None] = mapped_column(ForeignKey("folders.id", ondelete="SET NULL"), index=True)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    model_id: Mapped[str | None] = mapped_column(String(200))
    #: Last message of the branch being shown. No FK: messages already reference conversations, and a
    #: circular constraint would complicate deletes. Kept valid by services/conversation.
    current_leaf_id: Mapped[str | None] = mapped_column(String(32))
    behaviour_profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("behaviour_profiles.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow, index=True)

    messages: Mapped[list[Message]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", passive_deletes=True
    )


class Message(Base):
    """A turn in a conversation. `parent_id` forms a tree so edits and regenerations create branches."""

    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_conversation_created", "conversation_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(20))  # system | user | assistant | tool
    content: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="complete")  # streaming|complete|error|cancelled
    model_id: Mapped[str | None] = mapped_column(String(200))
    prompt_tokens: Mapped[int | None] = mapped_column(Integer)
    completion_tokens: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    #: Why generation ended: "stop", "length" (hit max tokens, can be continued), backend-specific otherwise.
    finish_reason: Mapped[str | None] = mapped_column(String(20))
    #: Memories that were placed in the model's context for this reply (ids only, for transparency).
    memory_ids: Mapped[list[str] | None] = mapped_column(JSON)
    #: How the model was chosen: {mode: manual|auto, task, model_id, reason} (null for older messages).
    route: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class ModelRecord(Base):
    """Registry entry for a model available through any provider. Synced from providers, never hardcoded.

    Milestone 11 extends this with licence, evaluated behaviour and behaviour profiles.
    """

    __tablename__ = "models"

    id: Mapped[str] = mapped_column(String(300), primary_key=True)  # "<provider>:<ref>"
    provider: Mapped[str] = mapped_column(String(50), index=True)
    provider_ref: Mapped[str] = mapped_column(String(250))
    display_name: Mapped[str] = mapped_column(String(250))
    family: Mapped[str | None] = mapped_column(String(100))
    parameter_size: Mapped[str | None] = mapped_column(String(50))
    quantization: Mapped[str | None] = mapped_column(String(50))
    format: Mapped[str | None] = mapped_column(String(50))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    context_length: Mapped[int | None] = mapped_column(Integer)
    digest: Mapped[str | None] = mapped_column(String(128))
    capabilities: Mapped[list[str]] = mapped_column(JSON, default=list)
    #: False when the provider no longer reports the model (removed, or provider offline at last sync).
    available: Mapped[bool] = mapped_column(Boolean, default=True)
    first_seen_at: Mapped[datetime] = mapped_column(default=utcnow)
    last_synced_at: Mapped[datetime] = mapped_column(default=utcnow)
    # Milestone 11: details read from the provider (Ollama /api/show, GGUF header, HF config).
    architecture: Mapped[str | None] = mapped_column(String(100))
    parameter_count: Mapped[int | None] = mapped_column(BigInteger)
    #: Short licence name (first line of the licence text, or the SPDX id).
    license: Mapped[str | None] = mapped_column(String(200))
    license_text: Mapped[str | None] = mapped_column(Text)
    #: Layer / attention sizes used to estimate KV-cache memory.
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    #: The digest the details above were read for (re-read when the model changes).
    details_digest: Mapped[str | None] = mapped_column(String(128))
    behaviour_profile_id: Mapped[str | None] = mapped_column(
        ForeignKey("behaviour_profiles.id", ondelete="SET NULL")
    )
    last_used_at: Mapped[datetime | None] = mapped_column()


class PromptTemplate(Base):
    """Reusable prompt text the user can insert into the composer."""

    __tablename__ = "prompt_templates"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class Attachment(Base):
    """An uploaded file. Stored under `<data_dir>/uploads/<id>/original<.ext>`; the user's filename is
    only kept for display and never used as a path."""

    __tablename__ = "attachments"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    #: Set for project knowledge files (shared by every chat in the project, never linked to a message).
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(20))  # pdf|docx|xlsx|csv|json|markdown|text|code|image
    mime_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    stored_path: Mapped[str] = mapped_column(String(300))  # relative to the uploads folder
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|processing|ready|failed
    error: Mapped[str | None] = mapped_column(Text)
    extracted_text: Mapped[str | None] = mapped_column(Text)
    char_count: Mapped[int | None] = mapped_column(Integer)
    page_count: Mapped[int | None] = mapped_column(Integer)
    #: Kind-specific details: image size, sheet names, truncation flags, encoding.
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    processed_at: Mapped[datetime | None] = mapped_column()


class MessageAttachment(Base):
    """Links attachments to user messages. A file can belong to several messages (an edited message keeps
    the original's attachments)."""

    __tablename__ = "message_attachments"

    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True)
    attachment_id: Mapped[str] = mapped_column(
        ForeignKey("attachments.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)


class DocumentChunk(Base):
    """A passage of an attachment's extracted text, used to pick relevant excerpts for long documents."""

    __tablename__ = "document_chunks"
    __table_args__ = (Index("ix_document_chunks_attachment_ordinal", "attachment_id", "ordinal"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    attachment_id: Mapped[str] = mapped_column(ForeignKey("attachments.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer)
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    #: Optional vector from a local embedding model (None when no embedding model is installed).
    embedding: Mapped[list[float] | None] = mapped_column(JSON)
    embedding_model: Mapped[str | None] = mapped_column(String(300))


class Memory(Base):
    """Something the assistant may recall in later turns. Always visible and editable by the user.

    Kinds and scope:
    - ``preference``: about the user; global.
    - ``summary``: a summary of one conversation (``conversation_id``); inherits its ``project_id``.
    - ``project``: notes for one project (``project_id``); only used in that project's chats.
    - ``knowledge``: reference text, typed or imported from a document; global.
    - ``temporary``: context for one conversation (``conversation_id``), optionally expiring.
    """

    __tablename__ = "memories"
    __table_args__ = (Index("ix_memories_kind_updated", "kind", "updated_at"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(200), default="")
    content: Mapped[str] = mapped_column(Text)
    importance: Mapped[int] = mapped_column(Integer, default=3)  # 1..5
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    source: Mapped[str] = mapped_column(String(20), default="user")  # user | message | import | summary
    #: Kind-specific details: imported filename, summary coverage.
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    expires_at: Mapped[datetime | None] = mapped_column(index=True)
    #: One vector per passage of `content` (see services/memory), from a local embedding model if installed.
    embeddings: Mapped[list[list[float]] | None] = mapped_column(JSON)
    embedding_model: Mapped[str | None] = mapped_column(String(300))
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    last_used_at: Mapped[datetime | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class Artifact(Base):
    """Viewable, runnable content (web page, React component, diagram, chart, document, code) with history.

    Created from a model reply (an `<artifact>` block) or by the user. Rendered only in the sandbox origin.
    """

    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    #: Stable name the model uses to update the artifact within a conversation (e.g. "todo-app").
    identifier: Mapped[str] = mapped_column(String(100))
    title: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20))  # html|react|svg|markdown|mermaid|chart|javascript|code
    language: Mapped[str | None] = mapped_column(String(40))  # for kind "code"
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    current_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow, index=True)


class ArtifactVersion(Base):
    """Immutable snapshot of an artifact's content. Editing or restoring adds a new version."""

    __tablename__ = "artifact_versions"
    __table_args__ = (Index("ux_artifact_versions_artifact_version", "artifact_id", "version", unique=True),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    artifact_id: Mapped[str] = mapped_column(ForeignKey("artifacts.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(20))  # model | user | restore
    #: Reply that produced this version (no FK: versions outlive regenerated branches).
    message_id: Mapped[str | None] = mapped_column(String(32), index=True)
    note: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class AgentRun(Base):
    """One agent task: a plan, then tool-using steps until a final answer, failure or cancellation."""

    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    task: Mapped[str] = mapped_column(Text)
    #: planning | running | waiting_approval | completed | failed | cancelled | interrupted
    status: Mapped[str] = mapped_column(String(20), default="planning", index=True)
    model_id: Mapped[str] = mapped_column(String(300))
    #: Scope for project search / document search. The agent can't change it.
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    plan: Mapped[list[str]] = mapped_column(JSON, default=list)
    result: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    max_steps: Mapped[int] = mapped_column(Integer, default=12)
    #: Run this one was retried from.
    retry_of: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column()


class AgentStep(Base):
    """A step of a run. Tool calls record their arguments, the approval decision and the result."""

    __tablename__ = "agent_steps"
    __table_args__ = (Index("ix_agent_steps_run_index", "run_id", "index"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id", ondelete="CASCADE"))
    index: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(20))  # plan | tool | final | error | note
    thought: Mapped[str] = mapped_column(Text, default="")
    tool: Mapped[str | None] = mapped_column(String(50))
    args: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    #: pending | waiting_approval | running | done | error | denied | cancelled
    status: Mapped[str] = mapped_column(String(20), default="done")
    #: How the call was allowed: auto | approved | denied | policy_denied (null for non-tool steps)
    approval: Mapped[str | None] = mapped_column(String(20))
    output: Mapped[str] = mapped_column(Text, default="")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column()


class BehaviourProfile(Base):
    """A user-editable preset: instructions and sampling defaults. Attached to a model, a project or a
    conversation; the most specific one applies."""

    __tablename__ = "behaviour_profiles"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(500), default="")
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    temperature: Mapped[float | None] = mapped_column()
    top_p: Mapped[float | None] = mapped_column()
    max_tokens: Mapped[int | None] = mapped_column(Integer)
    context_length: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)


class EvalRun(Base):
    """One evaluation of one model on chosen suites (reproducible: temperature 0, fixed seed, versions)."""

    __tablename__ = "eval_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    model_id: Mapped[str] = mapped_column(String(300), index=True)
    #: Model digest at the time, so results are tied to the exact weights.
    model_digest: Mapped[str | None] = mapped_column(String(128))
    suites: Mapped[list[str]] = mapped_column(JSON, default=list)
    #: suite -> version hash
    suite_versions: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    seed: Mapped[int] = mapped_column(Integer, default=7)
    status: Mapped[str] = mapped_column(
        String(20), default="queued"
    )  # queued|running|completed|failed|cancelled
    progress: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    #: Per-suite scores and measurements (see services/evaluation).
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(default=utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column()


class EvalResult(Base):
    __tablename__ = "eval_results"
    __table_args__ = (Index("ix_eval_results_run_suite", "run_id", "suite"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("eval_runs.id", ondelete="CASCADE"))
    suite: Mapped[str] = mapped_column(String(50))
    case_id: Mapped[str] = mapped_column(String(100))
    #: e.g. "should_answer" / "should_decline" for the refusal suite.
    category: Mapped[str] = mapped_column(String(50), default="")
    prompt: Mapped[str] = mapped_column(Text)
    output: Mapped[str] = mapped_column(Text, default="")
    passed: Mapped[bool | None] = mapped_column(Boolean)
    #: What the scorer observed, e.g. {"refused": true} or {"expected": "42", "got": "41"}.
    verdict: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    tokens_per_s: Mapped[float | None] = mapped_column()
    error: Mapped[str | None] = mapped_column(Text)
