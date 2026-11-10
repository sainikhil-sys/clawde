from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from core.evaluation.suites import SUITES
from models.registry import service as registry
from services.audit import service as audit
from services.evaluation import EvalManager, new_run
from storage.database.models import EvalResult, EvalRun, ModelRecord

from ..deps import DbDep, GatewayDep
from ..security import CsrfSessionDep, SessionDep, api_error, client_ip

router = APIRouter(prefix="/evaluations", tags=["evaluations"])


def _manager(request: Request) -> EvalManager:
    manager: EvalManager = request.app.state.evals
    return manager


def _run_out(r: EvalRun) -> dict[str, Any]:
    return {
        "id": r.id,
        "model_id": r.model_id,
        "model_digest": r.model_digest,
        "suites": r.suites,
        "suite_versions": r.suite_versions,
        "seed": r.seed,
        "status": r.status,
        "progress": r.progress,
        "total": r.total,
        "summary": r.summary,
        "error": r.error,
        "created_at": r.created_at.isoformat(),
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
    }


@router.get("/suites")
async def suites(_: SessionDep) -> list[dict[str, Any]]:
    return [
        {
            "key": s.key,
            "title": s.title,
            "kind": s.kind,
            "description": s.description,
            "cases": len(s.cases),
            "version": s.version,
        }
        for s in SUITES.values()
    ]


class EvalCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_id: str = Field(min_length=1, max_length=300)
    suites: list[str] = Field(default_factory=lambda: list(SUITES), max_length=10)


@router.post("", status_code=status.HTTP_201_CREATED)
async def start(
    body: EvalCreate, request: Request, _: CsrfSessionDep, db: DbDep, gateway: GatewayDep
) -> dict[str, Any]:
    manager = _manager(request)
    if manager.busy:
        raise api_error(status.HTTP_409_CONFLICT, "eval_running", "An evaluation is already running.")
    unknown = [s for s in body.suites if s not in SUITES]
    if unknown:
        raise api_error(status.HTTP_400_BAD_REQUEST, "unknown_suite", f"Unknown suite: {', '.join(unknown)}")
    rec = await db.get(ModelRecord, body.model_id)
    if rec is None or not rec.available or not registry.is_chat_model(rec):
        raise api_error(status.HTTP_400_BAD_REQUEST, "model_unavailable", "Choose an installed chat model.")
    run = await new_run(db, rec, body.suites)
    await audit.record(
        db, "evaluation.start", target_type="model", target_id=rec.id, details={"suites": run.suites},
        client_ip=client_ip(request),
    )  # fmt: skip
    await db.commit()
    await db.refresh(run)
    manager.start(run.id)
    return _run_out(run)


@router.get("")
async def list_runs(
    _: SessionDep, db: DbDep, model_id: Annotated[str | None, Query(max_length=300)] = None
) -> list[dict[str, Any]]:
    stmt = select(EvalRun).order_by(EvalRun.created_at.desc()).limit(100)
    if model_id:
        stmt = stmt.where(EvalRun.model_id == model_id)
    return [_run_out(r) for r in (await db.scalars(stmt)).all()]


@router.get("/{run_id}")
async def get_run(run_id: str, _: SessionDep, db: DbDep) -> dict[str, Any]:
    run = await db.get(EvalRun, run_id)
    if run is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "eval_not_found", "Evaluation not found.")
    results = (
        await db.scalars(select(EvalResult).where(EvalResult.run_id == run_id).order_by(EvalResult.id))
    ).all()
    return {
        **_run_out(run),
        "results": [
            {
                "suite": r.suite,
                "case_id": r.case_id,
                "category": r.category,
                "prompt": r.prompt,
                "output": r.output,
                "passed": r.passed,
                "verdict": r.verdict,
                "latency_ms": r.latency_ms,
                "tokens_per_s": r.tokens_per_s,
                "error": r.error,
            }
            for r in results
        ],
    }


@router.post("/{run_id}/cancel")
async def cancel(run_id: str, request: Request, _: CsrfSessionDep, db: DbDep) -> dict[str, Any]:
    if not await _manager(request).cancel(run_id):
        raise api_error(status.HTTP_409_CONFLICT, "eval_not_running", "This evaluation isn't running.")
    run = await db.get(EvalRun, run_id)
    assert run is not None
    await db.refresh(run)
    return _run_out(run)


@router.delete("/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete(run_id: str, request: Request, _: CsrfSessionDep, db: DbDep) -> None:
    run = await db.get(EvalRun, run_id)
    if run is None:
        raise api_error(status.HTTP_404_NOT_FOUND, "eval_not_found", "Evaluation not found.")
    if run.status in ("queued", "running"):
        raise api_error(status.HTTP_409_CONFLICT, "eval_running", "Cancel the evaluation first.")
    await db.delete(run)
    await db.commit()
