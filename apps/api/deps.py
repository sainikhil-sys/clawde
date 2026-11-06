"""Shared FastAPI dependencies. App-wide objects live on `app.state` (set in the lifespan)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from core.inference.gateway import InferenceGateway
from storage.database.engine import Database

from .config import Settings


def get_settings_dep(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_database(request: Request) -> Database:
    database: Database = request.app.state.database
    return database


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async for session in get_database(request).session():
        yield session


def get_gateway(request: Request) -> InferenceGateway:
    gateway: InferenceGateway = request.app.state.gateway
    return gateway


DbDep = Annotated[AsyncSession, Depends(get_db)]
GatewayDep = Annotated[InferenceGateway, Depends(get_gateway)]
SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
DatabaseDep = Annotated[Database, Depends(get_database)]
