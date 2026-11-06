from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, select

from storage.database import migrate
from storage.database.base import Base
from storage.database.engine import Database
from storage.database.models import Conversation, Message, Project


def _sync_url(path: Path) -> str:
    return f"sqlite:///{path.as_posix()}"


def _async_url(path: Path) -> str:
    return f"sqlite+aiosqlite:///{path.as_posix()}"


EXPECTED_TABLES = {
    "alembic_version",
    "app_sessions",
    "audit_events",
    "settings",
    "folders",
    "projects",
    "conversations",
    "messages",
    "models",
    "prompt_templates",
    "attachments",
    "message_attachments",
    "document_chunks",
    "memories",
    "artifacts",
    "artifact_versions",
}


def test_upgrade_downgrade_upgrade(tmp_path: Path) -> None:
    db_file = tmp_path / "m.db"
    url = _async_url(db_file)

    migrate.upgrade(url)
    assert set(inspect(create_engine(_sync_url(db_file))).get_table_names()) == EXPECTED_TABLES

    migrate.downgrade(url, "base")
    assert set(inspect(create_engine(_sync_url(db_file))).get_table_names()) == {"alembic_version"}

    migrate.upgrade(url)
    assert set(inspect(create_engine(_sync_url(db_file))).get_table_names()) == EXPECTED_TABLES


def test_migrations_match_models(tmp_path: Path) -> None:
    """Fails if someone changes an ORM model without adding a migration."""
    db_file = tmp_path / "drift.db"
    migrate.upgrade(_async_url(db_file))
    engine = create_engine(_sync_url(db_file))
    with engine.connect() as conn:
        ctx = MigrationContext.configure(conn, opts={"compare_type": True, "render_as_batch": True})
        diff = compare_metadata(ctx, Base.metadata)
    assert diff == []


def test_head_revision_is_single() -> None:
    assert migrate.head_revision() == "0007_artifacts"


async def test_foreign_keys_enforced_and_cascade(tmp_path: Path) -> None:
    db_file = tmp_path / "fk.db"
    url = _async_url(db_file)
    await asyncio.to_thread(migrate.upgrade, url)
    database = Database(url)
    try:
        async with database.sessionmaker() as s:
            project = Project(name="P")
            s.add(project)
            await s.flush()
            conv = Conversation(title="c", project_id=project.id)
            s.add(conv)
            await s.flush()
            s.add(Message(conversation_id=conv.id, role="user", content="hi"))
            await s.commit()

            # Deleting the project cascades to its conversations and messages at the database level.
            await s.delete(project)
            await s.commit()
            assert (await s.scalars(select(Conversation))).all() == []
            assert (await s.scalars(select(Message))).all() == []

        async with database.sessionmaker() as s:
            s.add(Message(conversation_id="does-not-exist", role="user", content="x"))
            with pytest.raises(Exception, match="FOREIGN KEY"):
                await s.commit()
    finally:
        await database.dispose()
