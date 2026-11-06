"""FastAPI application factory."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from storage.database import migrate
from storage.database.engine import Database

from .config import APP_VERSION, Settings, get_settings
from .logging_setup import configure_logging
from .middleware import BodySizeLimitMiddleware, OriginCheckMiddleware, RequestContextMiddleware
from .routers import audit, health, session, settings
from .security import CSRF_HEADER

log = structlog.get_logger("clawde.api")


def create_app(app_settings: Settings | None = None) -> FastAPI:
    cfg = app_settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cfg.data_dir.mkdir(parents=True, exist_ok=True)
        configure_logging(cfg.log_level, cfg.logs_dir if cfg.log_to_file else None)
        url = cfg.resolved_database_url
        if cfg.auto_migrate:
            # Alembic runs its own event loop; keep it off ours.
            await asyncio.to_thread(migrate.upgrade, url)
        database = Database(url)
        app.state.settings = cfg
        app.state.database = database
        log.info("api.started", version=APP_VERSION, data_dir=str(cfg.data_dir), host=cfg.host, port=cfg.port)
        try:
            yield
        finally:
            await database.dispose()
            log.info("api.stopped")

    app = FastAPI(
        title="Clawde API",
        version=APP_VERSION,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    api_prefix = "/api"
    for router in (health.router, session.router, settings.router, audit.router):
        app.include_router(router, prefix=api_prefix)

    # Starlette wraps in reverse order: the last added middleware runs first.
    app.add_middleware(OriginCheckMiddleware, allowed_origins=cfg.allowed_origins)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", CSRF_HEADER],
        expose_headers=["X-Request-ID"],
    )
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=cfg.max_request_bytes)
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=cfg.allowed_hosts)
    return app


def app_factory() -> FastAPI:
    """Entry point for `uvicorn --factory api.main:app_factory`."""
    return create_app()
