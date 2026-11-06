"""Runtime configuration. Every value can be overridden with a `CLAWDE_*` environment variable or `.env`."""

from __future__ import annotations

import ipaddress
import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_VERSION = "0.1.0"


def default_data_dir() -> Path:
    """Per-user data folder, deliberately outside the repository and outside synced folders."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "Clawde"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Clawde"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "clawde"


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CLAWDE_", env_file=".env", extra="ignore")

    data_dir: Path = Field(default_factory=default_data_dir)
    database_url: str | None = None

    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    #: Binding to a non-loopback address exposes the API to the network; it must be opted into explicitly.
    allow_remote_bind: bool = False

    #: Browser origins allowed to call the API (the web UI). Used for CORS and the Origin check.
    allowed_origins: list[str] = ["http://127.0.0.1:3000", "http://localhost:3000"]
    #: Accepted Host header values (without port). Rejecting others blocks DNS-rebinding attacks.
    allowed_hosts: list[str] = ["127.0.0.1", "localhost"]

    session_ttl_hours: int = Field(default=24 * 30, ge=1)
    #: Cookies are sent over plain HTTP on loopback; set true if the API is ever served over HTTPS.
    cookie_secure: bool = False
    #: Upper bound for ordinary JSON request bodies. File uploads get their own limits (Milestone 6).
    max_request_bytes: int = Field(default=1_048_576, ge=1024)

    #: Local Ollama server. Chat traffic goes only here; it is not an internet request.
    ollama_url: str = "http://127.0.0.1:11434"
    #: How long Ollama keeps a model loaded after the last request (RAM vs. reload latency).
    ollama_keep_alive: str = "10m"

    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_to_file: bool = True
    #: Apply pending database migrations at startup.
    auto_migrate: bool = True

    @model_validator(mode="after")
    def _check_bind(self) -> Settings:
        if not self.allow_remote_bind and not _is_loopback(self.host):
            raise ValueError(
                f"Refusing to bind to non-loopback host {self.host!r}. "
                "Set CLAWDE_ALLOW_REMOTE_BIND=true only if you understand the exposure."
            )
        return self

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite+aiosqlite:///{(self.data_dir / 'clawde.db').as_posix()}"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"


@lru_cache
def get_settings() -> Settings:
    return Settings()
