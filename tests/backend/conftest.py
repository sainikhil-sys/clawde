from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from api.config import Settings
from api.main import create_app

ORIGIN = "http://127.0.0.1:3000"
BASE_URL = "http://127.0.0.1:8000"


def make_settings(data_dir: Path, **overrides: object) -> Settings:
    return Settings(data_dir=data_dir, log_to_file=False, log_level="WARNING", **overrides)  # type: ignore[arg-type]


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    return tmp_path / "data"


@pytest.fixture
def settings(data_dir: Path) -> Settings:
    return make_settings(data_dir)


@pytest.fixture
async def app(settings: Settings) -> AsyncIterator[FastAPI]:
    application = create_app(settings)
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=BASE_URL) as c:
        yield c


async def start_session(client: httpx.AsyncClient) -> str:
    """Create a session like the web UI does and return the CSRF token."""
    resp = await client.post("/api/session", headers={"Origin": ORIGIN})
    assert resp.status_code == 201, resp.text
    token: str = resp.json()["csrf_token"]
    return token


def csrf_headers(token: str) -> dict[str, str]:
    return {"Origin": ORIGIN, "X-CSRF-Token": token}
