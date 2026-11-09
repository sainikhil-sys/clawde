from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from core.permissions import policy
from models.registry import service as registry
from services.agents.manager import ACTIVE, AgentError, AgentManager, latest_steps, run_payload, step_payload
from services.audit import service as audit
from services.sandbox.python_runner import PythonSandbox
from services.settings import service as settings_service
from storage.database.base import new_id
from storage.database.models import AgentRun, ModelRecord, Project
from storage.local_files.paths import UnsafePathError, safe_join

from ..deps import DbDep, GatewayDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip

router = APIRouter(prefix="/agents", tags=["agents"])

Policy = Literal["auto", "ask", "deny"]


def _manager(request: Request) -> AgentManager:
    manager: AgentManager = request.app.state.agents
    return manager


def _raise(exc: AgentError) -> None:
    raise api_error(exc.status, exc.code, exc.message)


# ---- Tools and permissions ----


class ToolOut(BaseModel):
    name: str
    description: str
    risk: str
    policy: Policy
    allowed: list[Policy]
    needs_project: bool


class PermissionsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool_permissions: dict[str, Policy]


@router.get("/tools", response_model=list[ToolOut])
async def list_tools(request: Request, _: SessionDep, db: DbDep) -> list[ToolOut]:
    stored = (await settings_service.load(db)).tool_permissions
    return [
        ToolOut(
            name=t.name,
            description=t.description,
            risk=t.risk,
            policy=policy.effective(t, stored),
            allowed=sorted(policy.allowed(t), key=["auto", "ask", "deny"].index),
            needs_project=t.needs_project,
        )
        for t in _manager(request).tools.all()
    ]


@router.put("/permissions", response_model=list[ToolOut])
async def update_permissions(
    body: PermissionsUpdate, request: Request, _: CsrfSessionDep, db: DbDep
) -> list[ToolOut]:
    tools = {t.name: t for t in _manager(request).tools.all()}
    for name, choice in body.tool_permissions.items():
        tool = tools.get(name)
        if tool is None:
            raise api_error(status.HTTP_404_NOT_FOUND, "tool_not_found", f"Unknown tool {name!r}.")
        if choice not in policy.allowed(tool):
            raise api_error(
                status.HTTP_400_BAD_REQUEST,
                "policy_not_allowed",
                f"{name} {'writes files' if tool.risk == 'write' else 'runs code'}, so it always needs "
                "approval (or can be turned off).",
            )
    current = dict((await settings_service.load(db)).tool_permissions)
    merged = {**current, **body.tool_permissions}
    _updated, changes = await settings_service.apply_patch(
        db, settings_service.AppSettingsPatch(tool_permissions=merged)
    )
    if changes:
        await audit.record(
            db, "agent.permissions", details={"changes": body.tool_permissions}, client_ip=client_ip(request)
        )
    await db.commit()
    return await list_tools(request, _, db)


# ---- Sandbox ----


class SandboxOut(BaseModel):
    docker: str
    image: str
    detail: str
    fallback_limits: str
    active_tier: Literal["docker", "fallback"]
    network_access_enabled: bool


def _sandbox(request: Request) -> PythonSandbox:
    sandbox: PythonSandbox = request.app.state.agents.services["python"]
    return sandbox


@router.get("/sandbox", response_model=SandboxOut)
async def sandbox_status(request: Request, _: SessionDep, db: DbDep, refresh: bool = False) -> SandboxOut:
    st = await _sandbox(request).status(refresh=refresh)
    return SandboxOut(
        docker=st.docker,
        image=st.image,
        detail=st.detail,
        fallback_limits=st.fallback_limits,
        active_tier="docker" if st.docker_ready else "fallback",
        network_access_enabled=(await settings_service.load(db)).network_access_enabled,
    )


@router.post("/sandbox/prepare", response_model=SandboxOut)
async def prepare_sandbox(request: Request, _: CsrfSessionDep, db: DbDep) -> SandboxOut:
    """Download the Docker image for the Python sandbox. Needs network access to be turned on in Settings."""
    if not (await settings_service.load(db)).network_access_enabled:
        raise api_error(
            status.HTTP_403_FORBIDDEN,
            "network_disabled",
            "Downloading the sandbox image needs internet access. Turn on network access in Settings first.",
        )
    sandbox = _sandbox(request)
    await audit.record(
        db, "network.docker_pull", details={"image": sandbox.image}, client_ip=client_ip(request)
    )
    await db.commit()
    try:
        await sandbox.prepare_docker()
    except RuntimeError as exc:
        raise api_error(status.HTTP_502_BAD_GATEWAY, "docker_pull_failed", str(exc)) from exc
    return await sandbox_status(request, _, db, refresh=True)


# ---- Workspace ----


class WorkspaceFile(BaseModel):
    path: str
    size: int
    modified: datetime


@router.get("/workspace", response_model=list[WorkspaceFile])
async def workspace_files(request: Request, _: SessionDep) -> list[WorkspaceFile]:
    root = _manager(request).workspace

    def scan() -> list[WorkspaceFile]:
        root.mkdir(parents=True, exist_ok=True)
        base = root.resolve()
        out = []
        for p in sorted(base.rglob("*")):
            if p.is_file() and not p.is_symlink():
                st = p.stat()
                out.append(
                    WorkspaceFile(
                        path=p.relative_to(base).as_posix(),
                        size=st.st_size,
                        modified=datetime.fromtimestamp(st.st_mtime, UTC),
                    )
                )
            if len(out) >= 500:
                break
        return out

    return await asyncio.to_thread(scan)


def _workspace_path(request: Request, path: str) -> Any:
    root = _manager(request).workspace
    root.mkdir(parents=True, exist_ok=True)
    try:
        target = safe_join(root, path)
    except UnsafePathError as exc:
        raise api_error(status.HTTP_400_BAD_REQUEST, "unsafe_path", str(exc)) from exc
    if not target.is_file():
        raise api_error(status.HTTP_404_NOT_FOUND, "file_not_found", "File not found.")
    return target


@router.get("/workspace/file")
async def download_workspace_file(
    request: Request, _: SessionDep, path: Annotated[str, Query(max_length=500)]
) -> Response:
    target = _workspace_path(request, path)
    data = await asyncio.to_thread(target.read_bytes)
    return Response(
        data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{target.name}"',
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@router.delete("/workspace/file", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace_file(
    request: Request, _: CsrfSessionDep, db: DbDep, path: Annotated[str, Query(max_length=500)]
) -> None:
    target = _workspace_path(request, path)
    await asyncio.to_thread(target.unlink)
    await audit.record(db, "workspace.delete", details={"path": path}, client_ip=client_ip(request))
    await db.commit()


# ---- Runs ----


class RunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: str = Field(min_length=1, max_length=8000)
    model_id: str | None = Field(default=None, max_length=300)
    project_id: str | None = Field(default=None, max_length=32)
    max_steps: int = Field(default=12, ge=1, le=40)


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approve: bool
    note: str = Field(default="", max_length=1000)


async def _resolve_model(db: DbDep, gateway: GatewayDep, requested: str | None) -> ModelRecord:
    model_id = requested or (await settings_service.load(db)).default_model
    if not model_id:
        raise api_error(status.HTTP_400_BAD_REQUEST, "no_model_selected", "Choose a model for the agent.")
    rec = await db.get(ModelRecord, model_id)
    if rec is None or not rec.available:
        await registry.sync(db, gateway)
        rec = await db.get(ModelRecord, model_id)
    if rec is None or not rec.available or not registry.is_chat_model(rec):
        raise api_error(
            status.HTTP_400_BAD_REQUEST, "model_unavailable", f"Model {model_id!r} isn't available for chat."
        )
    return rec


async def _get_run(db: DbDep, run_id: str) -> AgentRun:
    run = await db.get(AgentRun, run_id)
    if run is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "run_not_found", "Agent run not found.")
    return run


async def _detail(request: Request, db: DbDep, run: AgentRun) -> dict[str, Any]:
    tools = _manager(request).tools
    return {**run_payload(run), "steps": [step_payload(s, tools) for s in await latest_steps(db, run.id)]}


async def _create_and_start(
    request: Request,
    db: DbDep,
    *,
    task: str,
    model_id: str,
    project_id: str | None,
    max_steps: int,
    retry_of: str | None,
) -> dict[str, Any]:
    manager = _manager(request)
    if manager.active_count() >= 2:
        raise api_error(
            status.HTTP_409_CONFLICT, "too_many_runs", "At most 2 agent runs can be active at once."
        )
    run = AgentRun(
        id=new_id(),
        task=task,
        model_id=model_id,
        project_id=project_id,
        max_steps=max_steps,
        retry_of=retry_of,
    )
    db.add(run)
    await audit.record(
        db, "agent.start", target_type="agent_run", target_id=run.id, details={"model_id": model_id},
        client_ip=client_ip(request),
    )  # fmt: skip
    await db.commit()
    await db.refresh(run)
    try:
        await manager.start(run.id)
    except AgentError as exc:
        _raise(exc)
    return await _detail(request, db, run)


@router.get("/runs")
async def list_runs(
    _: SessionDep, db: DbDep, limit: Annotated[int, Query(ge=1, le=200)] = 50
) -> list[dict[str, Any]]:
    rows = (await db.scalars(select(AgentRun).order_by(AgentRun.created_at.desc()).limit(limit))).all()
    return [run_payload(r) for r in rows]


@router.post("/runs", status_code=status.HTTP_201_CREATED)
async def create_run(
    body: RunCreate, request: Request, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep
) -> dict[str, Any]:
    if body.project_id and await db.get(Project, body.project_id) is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "project_not_found", "Project not found.")
    model = await _resolve_model(db, gateway, body.model_id)
    return await _create_and_start(
        request, db, task=body.task.strip(), model_id=model.id, project_id=body.project_id,
        max_steps=body.max_steps, retry_of=None,
    )  # fmt: skip


@router.get("/runs/{run_id}")
async def get_run(run_id: str, request: Request, _: SessionDep, db: DbDep) -> dict[str, Any]:
    return await _detail(request, db, await _get_run(db, run_id))


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, request: Request, _: SessionDep, db: DbDep) -> StreamingResponse:
    """SSE: a `snapshot` (the run with all steps), then `run` / `step` updates until the run ends."""
    run = await _get_run(db, run_id)
    snapshot = await _detail(request, db, run)
    manager = _manager(request)

    async def stream() -> AsyncGenerator[bytes]:
        yield f"event: snapshot\ndata: {json.dumps(snapshot)}\n\n".encode()
        if snapshot["status"] not in ACTIVE:
            return
        events = manager.events(run_id)
        try:
            async for ev in events:
                kind = ev.pop("type")
                yield f"event: {kind}\ndata: {json.dumps(ev)}\n\n".encode()
        finally:
            await events.aclose()  # type: ignore[attr-defined]

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, request: Request, _: CsrfSessionDep, db: DbDep) -> dict[str, Any]:
    run = await _get_run(db, run_id)
    if run.status not in ACTIVE:
        raise api_error(status.HTTP_409_CONFLICT, "run_not_active", "This run has already finished.")
    await _manager(request).cancel(run_id)
    await db.refresh(run)
    return await _detail(request, db, run)


@router.post("/runs/{run_id}/steps/{step_id}/decision")
async def decide(
    run_id: str, step_id: str, body: Decision, request: Request, _: CsrfSessionDep, db: DbDep
) -> dict[str, Any]:
    await _get_run(db, run_id)
    try:
        _manager(request).decide(run_id, step_id, body.approve, body.note.strip())
    except AgentError as exc:
        _raise(exc)
    return {"ok": True}


@router.post("/runs/{run_id}/retry", status_code=status.HTTP_201_CREATED)
async def retry_run(
    run_id: str, request: Request, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep
) -> dict[str, Any]:
    old = await _get_run(db, run_id)
    if old.status in ACTIVE:
        raise api_error(status.HTTP_409_CONFLICT, "run_active", "Cancel the run before retrying it.")
    model = await _resolve_model(db, gateway, old.model_id)
    return await _create_and_start(
        request, db, task=old.task, model_id=model.id, project_id=old.project_id, max_steps=old.max_steps,
        retry_of=old.id,
    )  # fmt: skip


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_run(run_id: str, request: Request, _: CsrfSessionDep, db: DbDep) -> None:
    run = await _get_run(db, run_id)
    if run.status in ACTIVE:
        raise api_error(status.HTTP_409_CONFLICT, "run_active", "Cancel the run before deleting it.")
    await db.delete(run)
    await audit.record(
        db, "agent.delete", target_type="agent_run", target_id=run_id, client_ip=client_ip(request)
    )
    await db.commit()
