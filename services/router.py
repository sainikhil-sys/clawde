"""Multi-model router: choose a model for a message when the chat's model is set to "Auto".

1. Classify the message into a task type with fast, explainable heuristics (no model call):
   vision (images attached), document (files attached), code, math, or chat.
2. Candidates: available chat models with the needed capability (vision needs "vision").
3. Prefer the model the user assigned to that task (Model Library > Routing), then the default model, as
   long as they fit in memory; otherwise the largest capable model that fits; if nothing fits comfortably,
   the smallest.
Every reply records the decision and the reason, and choosing a model manually always overrides routing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from core.inference.gateway import InferenceGateway
from core.inference.provider import ProviderError
from models.registry import service as registry
from services import hardware
from services.settings import service as settings_service
from storage.database.models import ModelRecord

Task = Literal["chat", "code", "math", "document", "vision"]
TASKS: tuple[Task, ...] = ("chat", "code", "math", "document", "vision")
AUTO = "auto"

_CODE = re.compile(
    r"```|\b(def|class|function|const|let|import|return|SELECT|INSERT)\b|\b(python|javascript|typescript|java|"
    r"rust|golang|c\+\+|c#|sql|regex|bash|powershell|compile|stack ?trace|traceback|exception|bug|refactor|"
    r"unit tests?|api|json|html|css|react)\b|[{};]\s*$",
    re.IGNORECASE | re.MULTILINE,
)
_MATH = re.compile(
    r"\d+\s*[-+*/^\u00d7\u00f7]\s*\d+|\b(calculate|compute|solve|equation|integral|derivative|probability|percent(age)?|"
    r"how many|how much|sum of|average|proof|prove)\b|[=√∑∫π]|\d\s*%",
    re.IGNORECASE,
)


def classify(text: str, *, has_images: bool = False, has_documents: bool = False) -> tuple[Task, str]:
    if has_images:
        return "vision", "an image is attached"
    if has_documents:
        return "document", "files are attached"
    if _CODE.search(text):
        return "code", "the message looks like a programming question"
    if _MATH.search(text):
        return "math", "the message looks like a calculation"
    return "chat", "general conversation"


@dataclass(slots=True)
class Candidate:
    model_id: str
    size_bytes: int | None
    estimate: int | None
    fit: hardware.Fit


@dataclass(slots=True)
class Decision:
    model_id: str
    task: Task
    reason: str
    considered: list[dict[str, Any]] = field(default_factory=list)

    def as_route(self) -> dict[str, Any]:
        return {
            "mode": "auto",
            "task": self.task,
            "model_id": self.model_id,
            "reason": self.reason,
            "considered": self.considered,
        }


class NoModel(Exception):
    pass


async def loaded_bytes(gateway: InferenceGateway) -> dict[str, int]:
    """Memory each loaded model holds now, by model id (providers that can't say are skipped)."""
    out: dict[str, int] = {}
    for name, provider in gateway.providers.items():
        loaded_fn = getattr(provider, "loaded", None)
        if loaded_fn is None:
            continue
        try:
            for m in await loaded_fn():
                out[f"{name}:{m.ref}"] = m.size_bytes
        except ProviderError:
            continue
    return out


def _needs(task: Task) -> str:
    return "vision" if task == "vision" else registry.CHAT_CAPABILITY


async def decide(
    db: AsyncSession,
    gateway: InferenceGateway,
    *,
    text: str,
    has_images: bool = False,
    has_documents: bool = False,
    context_length: int = 4096,
) -> Decision:
    task, why = classify(text, has_images=has_images, has_documents=has_documents)
    prefs = await settings_service.load(db)
    models = [m for m in await registry.list_models(db) if registry.is_chat_model(m)]
    need = _needs(task)
    capable = [m for m in models if not m.capabilities or need in m.capabilities]
    if not capable and task == "vision":
        # No vision model installed: fall back to a text model (it'll be told an image is attached).
        task, why, need = (
            "chat",
            "an image is attached, but no installed model can see images",
            registry.CHAT_CAPABILITY,
        )
        capable = [m for m in models if not m.capabilities or need in m.capabilities]
    if not capable:
        raise NoModel("No installed model can handle this. Install a chat model in the Model Library.")

    snap = await hardware.snapshot()
    held = await loaded_bytes(gateway)
    by_id: dict[str, tuple[ModelRecord, Candidate]] = {}
    for m in capable:
        est = hardware.estimate_ram(
            m.size_bytes, m.details or {}, min(context_length, m.context_length or context_length)
        )
        by_id[m.id] = (
            m,
            Candidate(
                m.id,
                m.size_bytes,
                est,
                hardware.fit(est, snap.ram_available, already_loaded=held.get(m.id, 0)),
            ),
        )
    considered = [
        {"model_id": c.model_id, "fit": c.fit, "estimate_bytes": c.estimate} for _, c in by_id.values()
    ]

    def ok(c: Candidate) -> bool:
        return c.fit in ("fits", "tight", "unknown")

    assigned = prefs.router_assignments.get(task)
    if assigned and assigned in by_id:
        if ok(by_id[assigned][1]):
            return Decision(assigned, task, f"{why}; you assigned this model to {task} tasks", considered)
        why += f"; your {task} model doesn't fit in free memory now"
    elif assigned:
        why += f"; your {task} model isn't available"
    default = prefs.default_model
    if default and default in by_id and ok(by_id[default][1]):
        return Decision(default, task, f"{why}; using your default model", considered)
    fitting = [c for _, c in by_id.values() if c.fit == "fits"]
    if fitting:
        best = max(fitting, key=lambda c: c.size_bytes or 0)
        return Decision(
            best.model_id, task, f"{why}; the largest capable model that fits in free memory", considered
        )
    smallest = min(by_id.values(), key=lambda mc: mc[1].size_bytes or 0)[1]
    return Decision(
        smallest.model_id, task, f"{why}; nothing fits comfortably, so the smallest capable model", considered
    )


async def keep_one_loaded(gateway: InferenceGateway, keep: str) -> list[str]:
    """Unload other loaded chat models (best effort) so the next one has the memory; returns their ids."""
    unloaded: list[str] = []
    for name, provider in gateway.providers.items():
        loaded_fn = getattr(provider, "loaded", None)
        unload_fn = getattr(provider, "unload", None)
        if loaded_fn is None or unload_fn is None:
            continue
        try:
            for m in await loaded_fn():
                model_id = f"{name}:{m.ref}"
                if model_id != keep and "embed" not in m.ref.lower():
                    await unload_fn(m.ref)
                    unloaded.append(model_id)
        except ProviderError:
            continue
    return unloaded
