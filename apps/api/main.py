"""FastAPI application factory."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.telemetry import TelemetryConfig
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from core.inference.gateway import InferenceGateway
from core.inference.provider import ModelProvider
from models.adapters.ollama import OllamaProvider
from services.attachments import service as attachments
from services.conversation import service as conversations
from services.memory import service as memory
from storage.database import migrate
from storage.database.engine import Database

from .config import APP_VERSION, Settings, get_settings
from .logging_setup import configure_logging
from .middleware import BodySizeLimitMiddleware, OriginCheckMiddleware, RequestContextMiddleware
from .routers import attachments as attachments_router
from .routers import audit, folders, health, memories, models, projects, session, settings, templates
from .routers import conversations as conversations_router
from .security import CSRF_HEADER

log = structlog.get_logger("clawde.api")

#: FastAPI ships OpenTelemetry instrumentation. Nothing is exported without configuration, but we switch
#: every part off explicitly so no environment variable can turn it on behind the user's back.
_TELEMETRY_OFF: TelemetryConfig = {
    "tracing": False,
    "metrics": False,
    "logs": False,
    "operation_spans": False,
    "auto_configure": False,
}


def create_app(
    app_settings: Settings | None = None, providers: Sequence[ModelProvider] | None = None
) -> FastAPI:
    """`providers` lets tests inject in-process providers; by default Ollama is used."""
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
        recovered = await conversations.recover_interrupted(database.sessionmaker)
        if recovered:
            log.warning("api.recovered_interrupted_replies", count=recovered)
        async with database.sessionmaker() as db:
            expired = await memory.purge_expired(db)
            await db.commit()
        if expired:
            log.info("api.expired_memories_removed", count=expired)
        gateway = InferenceGateway(
            providers
            if providers is not None
            else [OllamaProvider(cfg.ollama_url, keep_alive=cfg.ollama_keep_alive)]
        )
        app.state.settings = cfg
        app.state.database = database
        app.state.gateway = gateway
        app.state.active_generations = set()
        app.state.summarising = set()
        app.state.background_tasks = set(
            await attachments.resume_unfinished(database.sessionmaker, gateway, cfg.uploads_dir)
        )
        log.info(
            "api.started",
            version=APP_VERSION,
            data_dir=str(cfg.data_dir),
            host=cfg.host,
            port=cfg.port,
            providers=list(gateway.providers),
        )
        try:
            yield
        finally:
            for task in list(app.state.background_tasks):
                task.cancel()
            await asyncio.gather(*app.state.background_tasks, return_exceptions=True)
            await gateway.aclose()
            await database.dispose()
            log.info("api.stopped")

    app = FastAPI(
        title="Clawde API",
        version=APP_VERSION,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
        telemetry=_TELEMETRY_OFF,
    )
    api_prefix = "/api"
    for router in (
        health.router,
        session.router,
        settings.router,
        audit.router,
        models.router,
        conversations_router.router,
        folders.router,
        templates.router,
        attachments_router.router,
        projects.router,
        memories.router,
    ):
        app.include_router(router, prefix=api_prefix)

    # Starlette wraps in reverse order: the last added middleware runs first.
    app.add_middleware(OriginCheckMiddleware, allowed_origins=cfg.allowed_origins)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", CSRF_HEADER],
        # Content-Disposition carries export filenames; browsers hide it from cross-origin JS unless exposed.
        expose_headers=["X-Request-ID", "Content-Disposition"],
    )
    app.add_middleware(
        BodySizeLimitMiddleware,
        max_bytes=cfg.max_request_bytes,
        # Multipart overhead on top of the file itself.
        path_limits={
            pattern: cfg.max_upload_bytes + 64 * 1024
            for pattern in (
                r"/api/attachments",
                r"/api/projects/[0-9a-f]{32}/knowledge",
                r"/api/memories/import",
            )
        },
    )
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=cfg.allowed_hosts)
    return app


def app_factory() -> FastAPI:
    """Entry point for `uvicorn --factory api.main:app_factory`."""
    return create_app()
