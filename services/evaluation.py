"""Run evaluation suites against a model in the background and store every output and score.

Runs are reproducible: temperature 0, a fixed seed, suite versions and the model digest are recorded. One
run at a time (evaluations load the model and compete with chat for memory); they can be cancelled. Speed
(tokens per second, time to first token) and the memory the model held are measured alongside.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from typing import Any

import anyio
import structlog
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.evaluation.suites import SUITES, Case, summarise
from core.inference.gateway import InferenceGateway
from core.inference.provider import ProviderError
from core.inference.types import ChatMessage, GenerationDone, GenerationParams, TokenDelta
from services.router import loaded_bytes
from storage.database.base import utcnow
from storage.database.models import EvalResult, EvalRun, ModelRecord

log = structlog.get_logger("clawde.evaluation")

SEED = 7
PARAMS = GenerationParams(temperature=0.0, top_p=1.0, max_tokens=320, context_length=4096, seed=SEED)


class EvalManager:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], gateway: InferenceGateway) -> None:
        self.sessionmaker = sessionmaker
        self.gateway = gateway
        self._task: asyncio.Task[None] | None = None
        self._run_id: str | None = None

    @property
    def busy(self) -> bool:
        return self._task is not None and not self._task.done()

    async def recover(self) -> None:
        async with self.sessionmaker() as db:
            await db.execute(
                update(EvalRun)
                .where(EvalRun.status.in_(("queued", "running")))
                .values(
                    status="cancelled", error="The app stopped during this evaluation.", finished_at=utcnow()
                )
            )
            await db.commit()

    def start(self, run_id: str) -> None:
        self._run_id = run_id
        self._task = asyncio.create_task(self._run(run_id), name=f"eval-{run_id}")

    async def cancel(self, run_id: str) -> bool:
        if not self.busy or self._run_id != run_id or self._task is None:
            return False
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await self._task
        return True

    async def shutdown(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task

    async def _generate(self, model_id: str, case: Case) -> tuple[str, int, float | None]:
        messages = []
        if case.system:
            messages.append(ChatMessage(role="system", content=case.system))
        messages.append(ChatMessage(role="user", content=case.prompt))
        params = PARAMS.model_copy(update={"response_format": "json"}) if case.system else PARAMS
        started = time.perf_counter()
        first: float | None = None
        parts: list[str] = []
        done: GenerationDone | None = None
        async for ev in self.gateway.chat_stream(model_id, messages, params):
            if isinstance(ev, TokenDelta):
                if first is None:
                    first = time.perf_counter()
                parts.append(ev.text)
            elif isinstance(ev, GenerationDone):
                done = ev
        end = time.perf_counter()
        tps = None
        if done and done.completion_tokens and first is not None and end > first:
            tps = round(done.completion_tokens / (end - first), 2)
        latency = round(((first or end) - started) * 1000)
        return "".join(parts), latency, tps

    async def _run(self, run_id: str) -> None:
        async with self.sessionmaker() as db:
            run = await db.get(EvalRun, run_id)
            assert run is not None
            run.status = "running"
            suites = [SUITES[k] for k in run.suites]
            run.total = sum(len(s.cases) for s in suites)
            model_id = run.model_id
            await db.commit()
        summary: dict[str, Any] = {}
        speeds: list[float] = []
        latencies: list[int] = []
        peak_held = 0
        done_count = 0
        try:
            for suite in suites:
                outcomes: list[tuple[Case, bool | None]] = []
                for case in suite.cases:
                    output, error, passed = "", None, None
                    verdict: dict[str, Any] = {}
                    latency: int | None = None
                    tps: float | None = None
                    try:
                        output, latency, tps = await self._generate(model_id, case)
                        passed, verdict = case.check(output)
                    except ProviderError as exc:
                        error = exc.message
                    if tps:
                        speeds.append(tps)
                    if latency is not None:
                        latencies.append(latency)
                    peak_held = max(peak_held, (await loaded_bytes(self.gateway)).get(model_id, 0))
                    outcomes.append((case, passed))
                    done_count += 1
                    async with self.sessionmaker() as db:
                        db.add(
                            EvalResult(
                                run_id=run_id,
                                suite=suite.key,
                                case_id=case.id,
                                category=case.category,
                                prompt=case.prompt,
                                output=output[:8000],
                                passed=passed,
                                verdict=verdict,
                                latency_ms=latency,
                                tokens_per_s=tps,
                                error=error,
                            )
                        )
                        await db.execute(
                            update(EvalRun).where(EvalRun.id == run_id).values(progress=done_count)
                        )
                        await db.commit()
                summary[suite.key] = summarise(suite, outcomes)
            summary["speed"] = {
                "tokens_per_s": round(sum(speeds) / len(speeds), 2) if speeds else None,
                "first_token_ms": round(sum(latencies) / len(latencies)) if latencies else None,
            }
            summary["memory"] = {"loaded_bytes": peak_held or None}
            async with self.sessionmaker() as db:
                await db.execute(
                    update(EvalRun)
                    .where(EvalRun.id == run_id)
                    .values(status="completed", summary=summary, finished_at=utcnow())
                )
                await db.commit()
        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                async with self.sessionmaker() as db:
                    await db.execute(
                        update(EvalRun)
                        .where(EvalRun.id == run_id)
                        .values(status="cancelled", summary=summary, finished_at=utcnow())
                    )
                    await db.commit()
            raise
        except Exception as exc:
            log.exception("evaluation.failed", run_id=run_id)
            with anyio.CancelScope(shield=True):
                async with self.sessionmaker() as db:
                    await db.execute(
                        update(EvalRun)
                        .where(EvalRun.id == run_id)
                        .values(
                            status="failed", error=f"{type(exc).__name__}: {exc}"[:500], finished_at=utcnow()
                        )
                    )
                    await db.commit()


async def new_run(db: AsyncSession, model: ModelRecord, suite_keys: list[str]) -> EvalRun:
    from storage.database.base import new_id

    keys = [k for k in suite_keys if k in SUITES] or list(SUITES)
    run = EvalRun(
        id=new_id(),
        model_id=model.id,
        model_digest=model.digest,
        suites=keys,
        suite_versions={k: SUITES[k].version for k in keys},
        seed=SEED,
        status="queued",
        total=sum(len(SUITES[k].cases) for k in keys),
    )
    db.add(run)
    return run
