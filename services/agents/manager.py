"""Runs agents in the background.

A run plans, then makes one tool call per step, pausing for approvals, until it gives a final answer.

Guarantees (tested):
- A tool whose policy is ``deny`` is never offered to the model, and if the model asks for it anyway it is
  recorded as denied and not run. A call the user rejects at the approval prompt is not run.
- Writing files and running code always wait for approval (see core/permissions).
- File tools stay inside the workspace (see core/tools/files).
- Cancelling stops the run immediately, including while it waits for approval or a model reply; nothing
  pending runs afterwards.
- Runs that were active when the API stopped are marked ``interrupted`` at startup (they are not resumed
  silently).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio
import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.agents import protocol
from core.context.budget import estimate_tokens
from core.inference.gateway import InferenceGateway
from core.inference.provider import ProviderError
from core.inference.types import ChatMessage, GenerationParams, TokenDelta
from core.permissions import policy
from core.tools.base import Tool, ToolContext, ToolError, ToolRegistry, ToolResult
from services.audit import service as audit
from services.settings import service as settings_service
from storage.database.base import utcnow
from storage.database.models import AgentRun, AgentStep

log = structlog.get_logger("clawde.agents")

ACTIVE = ("planning", "running", "waiting_approval")
MAX_CONCURRENT_RUNS = 2
MAX_INVALID_REPLIES = 3
PROVIDER_RETRIES = 2
TOOL_TIMEOUT_S = 120
CONTEXT_LENGTH = 8192
MAX_OUTPUT_TOKENS = 1024


class AgentError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass
class _Handle:
    task: asyncio.Task[None] | None = None
    subscribers: set[asyncio.Queue[dict[str, Any]]] = field(default_factory=set)
    #: Set while a step waits for the user: (step id, future resolved with (approved, note)).
    pending: tuple[str, asyncio.Future[tuple[bool, str]]] | None = None


def run_payload(run: AgentRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "task": run.task,
        "status": run.status,
        "model_id": run.model_id,
        "project_id": run.project_id,
        "plan": run.plan or [],
        "result": run.result,
        "error": run.error,
        "max_steps": run.max_steps,
        "retry_of": run.retry_of,
        "created_at": run.created_at.isoformat(),
        "updated_at": run.updated_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
    }


def step_payload(step: AgentStep, tools: ToolRegistry | None = None) -> dict[str, Any]:
    tool = tools.get(step.tool) if tools and step.tool else None
    return {
        "id": step.id,
        "run_id": step.run_id,
        "index": step.index,
        "kind": step.kind,
        "thought": step.thought,
        "tool": step.tool,
        "risk": tool.risk if tool else None,
        "args": step.args or {},
        "status": step.status,
        "approval": step.approval,
        "output": step.output,
        "data": step.data or {},
        "error": step.error,
        "created_at": step.created_at.isoformat(),
        "finished_at": step.finished_at.isoformat() if step.finished_at else None,
    }


class AgentManager:
    def __init__(
        self,
        *,
        sessionmaker: async_sessionmaker[AsyncSession],
        gateway: InferenceGateway,
        tools: ToolRegistry,
        workspace: Path,
        services: dict[str, Any] | None = None,
    ) -> None:
        self.sessionmaker = sessionmaker
        self.gateway = gateway
        self.tools = tools
        self.workspace = workspace
        self.services = services or {}
        self._handles: dict[str, _Handle] = {}

    # ---- Lifecycle ----

    async def recover(self) -> int:
        """Mark runs left active by a previous process as interrupted."""
        async with self.sessionmaker() as db:
            result = await db.execute(
                update(AgentRun)
                .where(AgentRun.status.in_(ACTIVE))
                .values(
                    status="interrupted",
                    error="The app stopped while this run was active.",
                    finished_at=utcnow(),
                )
            )
            await db.execute(
                update(AgentStep)
                .where(AgentStep.status.in_(("pending", "waiting_approval", "running")))
                .values(status="cancelled", finished_at=utcnow())
            )
            await db.commit()
            return int(getattr(result, "rowcount", 0) or 0)

    async def shutdown(self) -> None:
        tasks = [h.task for h in self._handles.values() if h.task and not h.task.done()]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def active_count(self) -> int:
        return sum(1 for h in self._handles.values() if h.task and not h.task.done())

    # ---- Public operations ----

    async def start(self, run_id: str) -> None:
        if self.active_count() >= MAX_CONCURRENT_RUNS:
            raise AgentError(
                "too_many_runs", f"At most {MAX_CONCURRENT_RUNS} agent runs can be active at once.", 409
            )
        handle = self._handles.setdefault(run_id, _Handle())
        handle.task = asyncio.create_task(self._run(run_id), name=f"agent-{run_id}")

    async def cancel(self, run_id: str) -> bool:
        handle = self._handles.get(run_id)
        if not handle or not handle.task or handle.task.done():
            return False
        handle.task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await handle.task
        return True

    def decide(self, run_id: str, step_id: str, approved: bool, note: str = "") -> None:
        handle = self._handles.get(run_id)
        if not handle or not handle.pending or handle.pending[0] != step_id:
            raise AgentError("no_pending_approval", "This step isn't waiting for approval.", 409)
        future = handle.pending[1]
        if not future.done():
            future.set_result((approved, note))

    async def events(self, run_id: str) -> AsyncIterator[dict[str, Any]]:
        """Live updates for a run until it finishes (callers send the current state first)."""
        handle = self._handles.setdefault(run_id, _Handle())
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
        handle.subscribers.add(queue)
        try:
            while True:
                if (not handle.task or handle.task.done()) and queue.empty():
                    return
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield {"type": "ping"}
                    continue
                yield event
                if event["type"] == "run" and event["run"]["status"] not in ACTIVE:
                    return
        finally:
            handle.subscribers.discard(queue)

    # ---- Internals ----

    def _emit(self, run_id: str, event: dict[str, Any]) -> None:
        handle = self._handles.get(run_id)
        if not handle:
            return
        for q in list(handle.subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(event)

    async def _set_run(self, run_id: str, **fields: Any) -> AgentRun:
        async with self.sessionmaker() as db:
            run = await db.get(AgentRun, run_id)
            assert run is not None
            for k, v in fields.items():
                setattr(run, k, v)
            await db.commit()
            await db.refresh(run)
        self._emit(run_id, {"type": "run", "run": run_payload(run)})
        return run

    async def _add_step(self, run_id: str, index: int, **fields: Any) -> AgentStep:
        async with self.sessionmaker() as db:
            step = AgentStep(run_id=run_id, index=index, **fields)
            db.add(step)
            await db.commit()
            await db.refresh(step)
        self._emit(run_id, {"type": "step", "step": step_payload(step, self.tools)})
        return step

    async def _update_step(self, step_id: str, **fields: Any) -> AgentStep:
        async with self.sessionmaker() as db:
            step = await db.get(AgentStep, step_id)
            assert step is not None
            for k, v in fields.items():
                setattr(step, k, v)
            await db.commit()
            await db.refresh(step)
        self._emit(step.run_id, {"type": "step", "step": step_payload(step, self.tools)})
        return step

    async def _complete(self, model_id: str, messages: list[ChatMessage]) -> str:
        params = GenerationParams(
            temperature=0.2,
            max_tokens=MAX_OUTPUT_TOKENS,
            context_length=CONTEXT_LENGTH,
            response_format="json",
        )
        delay = 1.0
        for attempt in range(PROVIDER_RETRIES + 1):
            try:
                parts: list[str] = []
                async for ev in self.gateway.chat_stream(model_id, messages, params):
                    if isinstance(ev, TokenDelta):
                        parts.append(ev.text)
                return "".join(parts)
            except ProviderError as exc:
                if attempt == PROVIDER_RETRIES:
                    raise
                log.warning("agent.provider_retry", attempt=attempt + 1, error=exc.message)
                await asyncio.sleep(delay)
                delay *= 2
        raise AssertionError("unreachable")

    def _available_tools(self, run: AgentRun, stored: Mapping[str, str]) -> list[Tool]:
        return [
            t
            for t in self.tools.all()
            if policy.effective(t, stored) != "deny" and (run.project_id or not t.needs_project)
        ]

    @staticmethod
    def _fit(messages: list[ChatMessage]) -> list[ChatMessage]:
        """Keep the conversation within the context window by shortening the oldest tool results first."""
        budget = CONTEXT_LENGTH - MAX_OUTPUT_TOKENS - 256
        out = list(messages)
        i = 2
        while sum(estimate_tokens(m.content) for m in out) > budget and i < len(out) - 1:
            m = out[i]
            if m.role == "user" and len(m.content) > 600:
                out[i] = ChatMessage(role="user", content=m.content[:500] + "\n… [older result shortened]")
            i += 1
        return out

    async def _run(self, run_id: str) -> None:
        handle = self._handles[run_id]
        current_step: str | None = None
        try:
            async with self.sessionmaker() as db:
                run = await db.get(AgentRun, run_id)
                assert run is not None
                stored = dict((await settings_service.load(db)).tool_permissions)
            tools = self._available_tools(run, stored)
            index = 0

            # 1. Plan.
            plan: list[str] = []
            try:
                reply = await self._complete(
                    run.model_id,
                    [
                        ChatMessage(role="system", content=protocol.PLAN_SYSTEM),
                        ChatMessage(role="user", content=f"Task: {run.task}"),
                    ],
                )
                plan = protocol.parse_plan(reply)
                await self._add_step(run_id, index, kind="plan", data={"plan": plan})
            except protocol.ProtocolError as exc:
                await self._add_step(
                    run_id, index, kind="note", output=f"No plan ({exc}); working step by step."
                )
            index += 1
            await self._set_run(run_id, status="running", plan=plan)

            # 2. Act.
            asks = [t.name for t in tools if policy.effective(t, stored) == "ask"]
            messages = [
                ChatMessage(role="system", content=protocol.agent_system(tools, asks)),
                ChatMessage(role="user", content=protocol.task_message(run.task, plan)),
            ]
            by_name = {t.name: t for t in tools}
            invalid = 0
            for _ in range(run.max_steps):
                reply = await self._complete(run.model_id, self._fit(messages))
                messages.append(ChatMessage(role="assistant", content=reply[:8000]))
                try:
                    action = protocol.parse_action(reply)
                except protocol.ProtocolError as exc:
                    invalid += 1
                    await self._add_step(
                        run_id, index, kind="error", status="error", error=str(exc), output=reply[:2000]
                    )
                    index += 1
                    if invalid >= MAX_INVALID_REPLIES:
                        raise AgentError(
                            "invalid_replies", "The model kept replying in an unusable format."
                        ) from exc
                    messages.append(ChatMessage(role="user", content=str(exc)))
                    continue
                invalid = 0

                if action.final_answer is not None:
                    await self._add_step(
                        run_id, index, kind="final", thought=action.thought, output=action.final_answer
                    )
                    await self._set_run(
                        run_id, status="completed", result=action.final_answer, finished_at=utcnow()
                    )
                    return

                assert action.tool is not None
                name = action.tool
                args = action.args or {}
                tool = self.tools.get(name)
                step = await self._add_step(
                    run_id, index, kind="tool", thought=action.thought, tool=name, args=args, status="pending"
                )
                current_step = step.id
                index += 1

                if tool is None or (tool.needs_project and not run.project_id):
                    obs = f"There is no tool called {name!r}. Available: {', '.join(by_name)}."
                    await self._update_step(step.id, status="error", error=obs, finished_at=utcnow())
                    messages.append(ChatMessage(role="user", content=obs))
                    current_step = None
                    continue
                if name not in by_name:  # policy says deny: never run, even if the model asks
                    obs = f"The tool {name!r} is turned off by the user. Don't use it."
                    await self._update_step(
                        step.id, status="denied", approval="policy_denied", error=obs, finished_at=utcnow()
                    )
                    await self._audit(run_id, "agent.tool_denied", {"tool": name, "reason": "policy"})
                    messages.append(ChatMessage(role="user", content=obs))
                    current_step = None
                    continue

                try:
                    parsed = tool.parse_args(args)
                except ToolError as exc:
                    await self._update_step(step.id, status="error", error=str(exc), finished_at=utcnow())
                    messages.append(
                        ChatMessage(
                            role="user",
                            content=protocol.observation(name, str(exc), untrusted=False, error=True),
                        )
                    )
                    current_step = None
                    continue

                approval = "auto"
                if policy.effective(tool, stored) == "ask":
                    approved, note = await self._wait_for_approval(run_id, step.id, handle)
                    if not approved:
                        obs = "The user denied this action." + (f" Their note: {note}" if note else "")
                        obs += " Don't retry it; continue another way or give your final answer."
                        await self._update_step(
                            step.id,
                            status="denied",
                            approval="denied",
                            error=note or None,
                            finished_at=utcnow(),
                        )
                        await self._audit(run_id, "agent.tool_denied", {"tool": name, "reason": "user"})
                        messages.append(ChatMessage(role="user", content=obs))
                        current_step = None
                        continue
                    approval = "approved"

                await self._update_step(step.id, status="running", approval=approval)
                ctx = ToolContext(
                    sessionmaker=self.sessionmaker,
                    gateway=self.gateway,
                    workspace=self.workspace,
                    run_id=run_id,
                    project_id=run.project_id,
                    services=self.services,
                )
                try:
                    result: ToolResult = await asyncio.wait_for(tool.run(ctx, parsed), timeout=TOOL_TIMEOUT_S)
                except ToolError as exc:
                    await self._update_step(step.id, status="error", error=str(exc), finished_at=utcnow())
                    messages.append(
                        ChatMessage(
                            role="user",
                            content=protocol.observation(name, str(exc), untrusted=False, error=True),
                        )
                    )
                    current_step = None
                    continue
                except TimeoutError:
                    msg = f"The tool took longer than {TOOL_TIMEOUT_S} seconds and was stopped."
                    await self._update_step(step.id, status="error", error=msg, finished_at=utcnow())
                    messages.append(
                        ChatMessage(
                            role="user", content=protocol.observation(name, msg, untrusted=False, error=True)
                        )
                    )
                    current_step = None
                    continue
                await self._update_step(
                    step.id, status="done", output=result.output, data=result.data, finished_at=utcnow()
                )
                if tool.risk in ("write", "execute"):
                    details: dict[str, Any] = {"tool": name, "approval": approval}
                    if name == "write_file":
                        details["path"] = str(result.data.get("path", ""))
                    if name == "python":
                        details["tier"] = result.data.get("tier")
                    await self._audit(run_id, "agent.tool_run", details)
                messages.append(
                    ChatMessage(
                        role="user",
                        content=protocol.observation(name, result.output, untrusted=result.untrusted),
                    )
                )
                current_step = None

            raise AgentError("step_limit", f"Stopped after {run.max_steps} steps without a final answer.")

        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                await self._finish_cancelled(run_id, current_step)
            raise
        except AgentError as exc:
            with anyio.CancelScope(shield=True):
                await self._set_run(run_id, status="failed", error=exc.message, finished_at=utcnow())
        except ProviderError as exc:
            with anyio.CancelScope(shield=True):
                await self._set_run(
                    run_id, status="failed", error=f"Model error: {exc.message}", finished_at=utcnow()
                )
        except Exception as exc:
            log.exception("agent.unexpected_error", run_id=run_id)
            with anyio.CancelScope(shield=True):
                await self._set_run(
                    run_id,
                    status="failed",
                    error=f"Unexpected error: {type(exc).__name__}",
                    finished_at=utcnow(),
                )
        finally:
            handle.pending = None

    async def _wait_for_approval(self, run_id: str, step_id: str, handle: _Handle) -> tuple[bool, str]:
        future: asyncio.Future[tuple[bool, str]] = asyncio.get_running_loop().create_future()
        handle.pending = (step_id, future)
        await self._update_step(step_id, status="waiting_approval")
        await self._set_run(run_id, status="waiting_approval")
        try:
            approved, note = await future
        finally:
            handle.pending = None
        await self._audit(run_id, "agent.approval", {"step_id": step_id, "approved": approved})
        await self._set_run(run_id, status="running")
        return approved, note

    async def _finish_cancelled(self, run_id: str, step_id: str | None) -> None:
        if step_id:
            await self._update_step(step_id, status="cancelled", finished_at=utcnow())
        await self._set_run(run_id, status="cancelled", finished_at=utcnow())
        await self._audit(run_id, "agent.cancel", {})

    async def _audit(self, run_id: str, action: str, details: dict[str, Any]) -> None:
        async with self.sessionmaker() as db:
            await audit.record(
                db,
                action,
                target_type="agent_run",
                target_id=run_id,
                details=details,
                actor=f"agent:{run_id}",
            )
            await db.commit()


async def latest_steps(db: AsyncSession, run_id: str) -> list[AgentStep]:
    return list(
        (
            await db.scalars(select(AgentStep).where(AgentStep.run_id == run_id).order_by(AgentStep.index))
        ).all()
    )
