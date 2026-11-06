"""ORM models. M3: sessions, audit log, settings, conversation core. M4: model registry.
M5: active branch pointer, finish reasons, prompt templates. M6: attachments and document chunks.
M7: project knowledge (attachments.project_id).

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
