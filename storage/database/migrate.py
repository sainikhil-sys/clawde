"""Programmatic Alembic entry points (used at startup, by the CLI and by tests)."""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def alembic_config(url: str) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    # Percent signs would be treated as interpolation by configparser.
    cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return cfg


def upgrade(url: str, revision: str = "head") -> None:
    """Blocking: runs its own event loop, so call it via `asyncio.to_thread` from async code."""
    command.upgrade(alembic_config(url), revision)


def downgrade(url: str, revision: str) -> None:
    command.downgrade(alembic_config(url), revision)


def head_revision() -> str | None:
    return ScriptDirectory.from_config(alembic_config("sqlite://")).get_current_head()
