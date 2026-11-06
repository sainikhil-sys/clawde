from __future__ import annotations

from fastapi import APIRouter, Request

from services.audit import service as audit
from services.settings import service as settings_service
from services.settings.service import AppSettings, AppSettingsPatch

from ..deps import DbDep
from ..security import CsrfSessionDep, SessionDep, client_ip

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=AppSettings)
async def get_settings(_: SessionDep, db: DbDep) -> AppSettings:
    return await settings_service.load(db)


@router.patch("", response_model=AppSettings)
async def update_settings(
    patch: AppSettingsPatch, request: Request, _: CsrfSessionDep, db: DbDep
) -> AppSettings:
    updated, changes = await settings_service.apply_patch(db, patch)
    if changes:
        await audit.record(db, "settings.update", details={"changes": changes}, client_ip=client_ip(request))
    await db.commit()
    return updated
