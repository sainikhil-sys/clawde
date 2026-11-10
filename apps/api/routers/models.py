from __future__ import annotations

import asyncio
import json
import re
import shutil
from collections.abc import AsyncGenerator, AsyncIterator
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from core.inference.provider import ProviderError
from models.adapters.transformers_local import download_hf
from models.registry import service as registry
from services import hardware, network
from services import router as auto_router
from services.audit import service as audit
from services.model_files import ModelFileError, read_gguf, read_hf_folder
from services.settings import service as settings_service
from storage.database.models import BehaviourProfile, EvalRun, ModelRecord

from ..deps import DbDep, GatewayDep, SettingsDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip

router = APIRouter(prefix="/models", tags=["models"])

#: Context length used for the memory estimate shown in lists (the app default).
ESTIMATE_CONTEXT = 4096


class ModelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    provider: str
    provider_ref: str
    display_name: str
    family: str | None
    parameter_size: str | None
    quantization: str | None
    format: str | None
    size_bytes: int | None
    context_length: int | None
    capabilities: list[str]
    available: bool
    chat: bool
    last_synced_at: datetime
    architecture: str | None = None
    parameter_count: int | None = None
    license: str | None = None
    behaviour_profile_id: str | None = None
    last_used_at: datetime | None = None
    #: RAM needed at ESTIMATE_CONTEXT tokens (weights + KV cache); null when the size is unknown.
    estimated_ram_bytes: int | None = None
    #: Whether the estimate could use the model's real layer sizes (else an approximation).
    estimate_exact: bool = False
    fit_now: str = "unknown"
    fit_total: str = "unknown"
    loaded: bool = False
    #: Latest completed evaluation summary, if any.
    evaluation: dict[str, Any] | None = None

    @classmethod
    def from_record(cls, rec: ModelRecord) -> ModelOut:
        return cls.model_validate(
            {
                **{c: getattr(rec, c) for c in cls.model_fields if hasattr(rec, c) and c != "chat"},
                "chat": registry.is_chat_model(rec),
            }
        )


class ModelDetail(ModelOut):
    license_text: str | None = None
    details: dict[str, Any] = {}


class ProviderStatusOut(BaseModel):
    name: str
    status: str
    message: str | None
    model_count: int


class ModelList(BaseModel):
    models: list[ModelOut]
    providers: list[ProviderStatusOut]


async def _enrich(db: DbDep, gateway: GatewayDep, records: list[ModelRecord]) -> list[ModelOut]:
    snap = await hardware.snapshot()
    held = await auto_router.loaded_bytes(gateway)
    evals: dict[str, dict[str, Any]] = {}
    rows = (
        await db.scalars(
            select(EvalRun)
            .where(EvalRun.status == "completed")
            .order_by(EvalRun.finished_at.desc())
            .limit(500)
        )
    ).all()
    for r in rows:
        evals.setdefault(r.model_id, {"run_id": r.id, "finished_at": r.finished_at, **(r.summary or {})})
    out = []
    for rec in records:
        ctx = min(ESTIMATE_CONTEXT, rec.context_length or ESTIMATE_CONTEXT)
        est = hardware.estimate_ram(rec.size_bytes, rec.details or {}, ctx)
        item = ModelOut.from_record(rec)
        item.estimated_ram_bytes = est
        item.estimate_exact = hardware.kv_cache_bytes(rec.details or {}, ctx) is not None
        item.fit_now = hardware.fit(est, snap.ram_available, already_loaded=held.get(rec.id, 0))
        item.fit_total = hardware.fit(est, int(snap.ram_total * 0.75))
        item.loaded = rec.id in held
        item.evaluation = evals.get(rec.id)
        out.append(item)
    return out


@router.get("", response_model=ModelList)
async def list_models(
    _: SessionDep,
    db: DbDep,
    gateway: GatewayDep,
    request: Request,
    include_unavailable: Annotated[bool, Query()] = False,
) -> ModelList:
    """Syncs the registry with every provider, then lists models with memory fit and the latest evaluation."""
    statuses = await registry.sync(db, gateway)
    await db.commit()
    records = await registry.list_models(db, include_unavailable=include_unavailable)
    return ModelList(
        models=await _enrich(db, gateway, records),
        providers=[
            ProviderStatusOut(name=s.name, status=s.status, message=s.message, model_count=s.model_count)
            for s in statuses
        ],
    )


# ---- Hardware and routing (declared before /{model_id} so the paths don't collide) ----


@router.get("/system/hardware")
async def system_hardware(_: SessionDep, gateway: GatewayDep) -> dict[str, Any]:
    snap = await hardware.snapshot()
    held = await auto_router.loaded_bytes(gateway)
    return {**hardware.as_json(snap), "loaded": [{"model_id": k, "bytes": v} for k, v in held.items()]}


class RoutingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignments: dict[str, str] | None = None
    keep_one_model_loaded: bool | None = None


@router.get("/system/routing")
async def routing(_: SessionDep, db: DbDep) -> dict[str, Any]:
    prefs = await settings_service.load(db)
    return {
        "tasks": list(auto_router.TASKS),
        "assignments": prefs.router_assignments,
        "keep_one_model_loaded": prefs.keep_one_model_loaded,
    }


@router.put("/system/routing")
async def update_routing(
    body: RoutingUpdate, request: Request, _: CsrfSessionDep, db: DbDep
) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    if body.assignments is not None:
        bad = [t for t in body.assignments if t not in auto_router.TASKS]
        if bad:
            raise api_error(
                status.HTTP_400_BAD_REQUEST, "unknown_task", f"Unknown task type: {', '.join(bad)}"
            )
        patch["router_assignments"] = {t: m for t, m in body.assignments.items() if m}
    if body.keep_one_model_loaded is not None:
        patch["keep_one_model_loaded"] = body.keep_one_model_loaded
    _s, changes = await settings_service.apply_patch(db, settings_service.AppSettingsPatch(**patch))
    if changes:
        await audit.record(db, "settings.update", details={"changes": changes}, client_ip=client_ip(request))
    await db.commit()
    return await routing(_, db)


class RoutePreview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=20_000)
    has_images: bool = False
    has_documents: bool = False


@router.post("/system/routing/preview")
async def preview_route(
    body: RoutePreview, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep
) -> dict[str, Any]:
    """Which model Auto would pick for this message, and why (doesn't load anything)."""
    await registry.sync(db, gateway)
    await db.commit()
    try:
        d = await auto_router.decide(
            db, gateway, text=body.text, has_images=body.has_images, has_documents=body.has_documents
        )
    except auto_router.NoModel as exc:
        raise api_error(status.HTTP_400_BAD_REQUEST, "no_model", str(exc)) from exc
    return d.as_route()


# ---- Adding models ----


def _ndjson(events: AsyncIterator[dict[str, Any]], *, final: Any = None) -> StreamingResponse:
    async def body() -> AsyncGenerator[bytes]:
        try:
            async for ev in events:
                yield (json.dumps(ev) + "\n").encode()
            if final is not None:
                yield (json.dumps(await final()) + "\n").encode()
        except ProviderError as exc:
            yield (json.dumps({"error": exc.message}) + "\n").encode()
        except (ValueError, OSError) as exc:
            yield (json.dumps({"error": str(exc)}) + "\n").encode()

    return StreamingResponse(body(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


_OLLAMA_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,150}(:[a-zA-Z0-9._-]{1,80})?$")


class PullRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=240, description="Ollama model name, e.g. qwen2.5:0.5b")


@router.post("/pull")
async def pull(
    body: PullRequest, request: Request, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep
) -> StreamingResponse:
    """Download a model from the Ollama library (internet). Streams NDJSON progress lines."""
    if not _OLLAMA_NAME.match(body.name):
        raise api_error(status.HTTP_400_BAD_REQUEST, "invalid_name", "That isn't a valid Ollama model name.")
    try:
        await network.require(
            db,
            "Downloading a model",
            destination=f"ollama registry: {body.name}",
            client_ip=client_ip(request),
        )
    except network.NetworkDisabled as exc:
        raise api_error(status.HTTP_403_FORBIDDEN, "network_disabled", exc.message) from exc
    await db.commit()
    provider = gateway.providers.get("ollama")
    if provider is None:
        raise api_error(status.HTTP_400_BAD_REQUEST, "provider_unavailable", "Ollama isn't configured.")
    return _ndjson(provider.pull(body.name))  # type: ignore[attr-defined]


class HFDownload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    repo_id: str = Field(min_length=3, max_length=200, pattern=r"^[A-Za-z0-9][\w.-]*/[\w.-]+$")


@router.post("/hf-download")
async def hf_download(
    body: HFDownload, request: Request, _: CsrfSessionDep, db: DbDep, settings: SettingsDep
) -> StreamingResponse:
    """Download a Hugging Face model (safetensors + tokenizer only) for Transformers (internet)."""
    try:
        await network.require(
            db,
            "Downloading a model",
            destination=f"huggingface.co: {body.repo_id}",
            client_ip=client_ip(request),
        )
    except network.NetworkDisabled as exc:
        raise api_error(status.HTTP_403_FORBIDDEN, "network_disabled", exc.message) from exc
    await db.commit()

    async def events() -> AsyncIterator[dict[str, Any]]:
        yield {"status": f"downloading {body.repo_id}"}
        path = await asyncio.to_thread(download_hf, body.repo_id, settings.hf_models_dir)
        yield {"status": "success", "folder": path.name}

    return _ndjson(events())


class ImportInspect(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=1000)


def _inspect(path_text: str) -> Any:
    path = Path(path_text.strip().strip('"')).expanduser()
    if path.is_dir():
        return read_hf_folder(path)
    return read_gguf(path)


@router.post("/import/inspect")
async def inspect_import(body: ImportInspect, _: CsrfSessionDep) -> dict[str, Any]:
    """Read a local .gguf file or Hugging Face folder's metadata (nothing is copied yet)."""
    try:
        info = await asyncio.to_thread(_inspect, body.path)
    except ModelFileError as exc:
        raise api_error(status.HTTP_400_BAD_REQUEST, "invalid_model_file", str(exc)) from exc
    snap = await hardware.snapshot()
    ctx = min(ESTIMATE_CONTEXT, info.context_length or ESTIMATE_CONTEXT)
    est = hardware.estimate_ram(info.size_bytes, info.details, ctx)
    return {
        **{
            k: getattr(info, k)
            for k in (
                "path",
                "format",
                "size_bytes",
                "name",
                "architecture",
                "parameter_count",
                "quantization",
                "context_length",
                "license",
            )
        },
        "estimated_ram_bytes": est,
        "fit_total": hardware.fit(est, int(snap.ram_total * 0.75)),
        "target": "ollama" if info.format == "gguf" else "transformers",
    }


class ImportRequest(ImportInspect):
    name: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9._-]*$")


@router.post("/import")
async def import_model(
    body: ImportRequest,
    request: Request,
    _: CsrfSessionDep,
    db: DbDep,
    gateway: GatewayDep,
    settings: SettingsDep,
) -> StreamingResponse:
    """Import a local model (no internet): a .gguf file into Ollama, or a Hugging Face folder."""
    try:
        info = await asyncio.to_thread(_inspect, body.path)
    except ModelFileError as exc:
        raise api_error(status.HTTP_400_BAD_REQUEST, "invalid_model_file", str(exc)) from exc
    await audit.record(
        db, "model.import", details={"name": body.name, "format": info.format}, client_ip=client_ip(request)
    )
    await db.commit()
    if info.format == "gguf":
        provider = gateway.providers.get("ollama")
        if provider is None:
            raise api_error(status.HTTP_400_BAD_REQUEST, "provider_unavailable", "Ollama isn't configured.")
        return _ndjson(provider.import_gguf(body.name, Path(info.path)))  # type: ignore[attr-defined]

    target = settings.hf_models_dir / body.name
    if target.exists():
        raise api_error(
            status.HTTP_409_CONFLICT, "name_taken", "A local model with that name already exists."
        )

    async def copy() -> AsyncIterator[dict[str, Any]]:
        yield {"status": "copying model folder"}
        await asyncio.to_thread(
            shutil.copytree,
            info.path,
            target,
            ignore=shutil.ignore_patterns("*.bin", "*.pt", "*.pth", "*.pkl", "*.py"),
        )
        yield {"status": "success", "folder": body.name}

    return _ndjson(copy())


# ---- One model ----


async def _get(db: DbDep, model_id: str) -> ModelRecord:
    rec = await db.get(ModelRecord, model_id)
    if rec is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "model_not_found", "Model not found.")
    return rec


@router.get("/{model_id:path}/detail", response_model=ModelDetail)
async def model_detail(model_id: str, _: SessionDep, db: DbDep, gateway: GatewayDep) -> ModelDetail:
    rec = await _get(db, model_id)
    [item] = await _enrich(db, gateway, [rec])
    return ModelDetail.model_validate(
        {**item.model_dump(), "license_text": rec.license_text, "details": rec.details or {}}
    )


class ModelPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    behaviour_profile_id: str | None


@router.patch("/{model_id:path}/profile", response_model=ModelDetail)
async def set_model_profile(
    model_id: str, body: ModelPatch, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep
) -> ModelDetail:
    rec = await _get(db, model_id)
    if body.behaviour_profile_id and await db.get(BehaviourProfile, body.behaviour_profile_id) is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "profile_not_found", "Behaviour profile not found.")
    rec.behaviour_profile_id = body.behaviour_profile_id
    await db.commit()
    return await model_detail(model_id, _, db, gateway)


@router.post("/{model_id:path}/unload")
async def unload_model(model_id: str, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep) -> dict[str, bool]:
    rec = await _get(db, model_id)
    provider = gateway.providers.get(rec.provider)
    unload = getattr(provider, "unload", None)
    if unload is None:
        raise api_error(status.HTTP_400_BAD_REQUEST, "not_supported", "This provider can't unload models.")
    try:
        await unload(rec.provider_ref)
    except ProviderError as exc:
        raise api_error(status.HTTP_502_BAD_GATEWAY, exc.code, exc.message) from exc
    return {"ok": True}


@router.delete("/{model_id:path}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_model(
    model_id: str, request: Request, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep, settings: SettingsDep
) -> None:
    """Remove a model's files (Ollama model, or a local Hugging Face folder). llama.cpp models are managed by
    llama-server itself."""
    rec = await _get(db, model_id)
    if rec.provider == "ollama":
        provider = gateway.providers.get("ollama")
        try:
            await provider.delete(rec.provider_ref)  # type: ignore[union-attr]
        except ProviderError as exc:
            raise api_error(status.HTTP_502_BAD_GATEWAY, exc.code, exc.message) from exc
    elif rec.provider == "transformers":
        folder = settings.hf_models_dir / rec.provider_ref
        if folder.parent.resolve() != settings.hf_models_dir.resolve():
            raise api_error(
                status.HTTP_400_BAD_REQUEST, "unsafe_path", "Refusing to delete outside the models folder."
            )
        provider = gateway.providers.get("transformers")
        if provider is not None:
            await provider.unload(rec.provider_ref)  # type: ignore[attr-defined]
        await asyncio.to_thread(shutil.rmtree, folder, True)
    else:
        raise api_error(
            status.HTTP_400_BAD_REQUEST,
            "not_supported",
            "Remove llama.cpp models from llama-server's model folder.",
        )
    rec.available = False
    await audit.record(
        db, "model.delete", target_type="model", target_id=model_id, client_ip=client_ip(request)
    )
    await db.commit()
