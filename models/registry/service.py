"""Model registry: the app's view of every model any provider offers. Populated by syncing providers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.inference.gateway import InferenceGateway
from core.inference.provider import ProviderError
from core.inference.types import ModelDetails
from storage.database.base import utcnow
from storage.database.models import ModelRecord

log = structlog.get_logger("clawde.models.registry")

#: Capability that marks a model usable for chat. Embedding-only models lack it.
CHAT_CAPABILITY = "completion"


@dataclass(frozen=True, slots=True)
class ProviderStatus:
    name: str
    status: str  # "ok" | "unavailable" | "error"
    message: str | None = None
    model_count: int = 0


async def sync(db: AsyncSession, gateway: InferenceGateway) -> list[ProviderStatus]:
    """Upsert models from every provider. Models a reachable provider no longer lists become unavailable.

    If a provider is unreachable its models are marked unavailable too, since they cannot be used right now.
    The caller commits.
    """
    now = utcnow()
    statuses: list[ProviderStatus] = []
    existing = {m.id: m for m in (await db.scalars(select(ModelRecord))).all()}

    for name, provider in gateway.providers.items():
        try:
            found = await provider.list_models()
        except ProviderError as exc:
            log.warning("registry.provider_unavailable", provider=name, error=exc.message)
            for stale in existing.values():
                if stale.provider == name:
                    stale.available = False
            statuses.append(
                ProviderStatus(
                    name, "unavailable" if exc.code == "provider_unavailable" else "error", exc.message
                )
            )
            continue

        seen: set[str] = set()
        for pm in found:
            seen.add(pm.model_id)
            rec = existing.get(pm.model_id)
            if rec is None:
                rec = ModelRecord(id=pm.model_id, provider=name, provider_ref=pm.ref, first_seen_at=now)
                db.add(rec)
                existing[pm.model_id] = rec
            rec.display_name = pm.display_name
            rec.family = pm.family
            rec.parameter_size = pm.parameter_size
            rec.quantization = pm.quantization
            rec.format = pm.format
            rec.size_bytes = pm.size_bytes
            rec.context_length = pm.context_length
            rec.digest = pm.digest
            rec.capabilities = list(pm.capabilities)
            rec.available = True
            rec.last_synced_at = now
        for stale in existing.values():
            if stale.provider == name and stale.id not in seen:
                stale.available = False
        statuses.append(ProviderStatus(name, "ok", model_count=len(found)))
        await _refresh_details(provider, [r for r in existing.values() if r.provider == name and r.available])
    return statuses


async def _refresh_details(provider: Any, records: list[ModelRecord]) -> None:
    """Read licence, architecture and layer shapes for models whose weights changed (by digest)."""
    details_fn = getattr(provider, "details", None)
    if details_fn is None:
        return
    for rec in records:
        if rec.details_digest is not None and rec.details_digest == (rec.digest or ""):
            continue
        try:
            d: ModelDetails | None = await details_fn(rec.provider_ref)
        except ProviderError as exc:
            log.warning("registry.details_failed", model=rec.id, error=exc.message)
            continue
        if d is None:
            continue
        apply_details(rec, d)
        rec.details_digest = rec.digest or ""


def apply_details(rec: ModelRecord, d: ModelDetails) -> None:
    rec.architecture = d.architecture
    rec.parameter_count = d.parameter_count
    rec.license = d.license
    rec.license_text = d.license_text
    if d.context_length and not rec.context_length:
        rec.context_length = d.context_length
    rec.details = {
        k: v
        for k, v in {
            "layers": d.layers,
            "embedding_length": d.embedding_length,
            "head_count": d.head_count,
            "head_count_kv": d.head_count_kv,
            "max_context_length": d.context_length,
        }.items()
        if v is not None
    }


async def list_models(db: AsyncSession, *, include_unavailable: bool = False) -> list[ModelRecord]:
    stmt = select(ModelRecord).order_by(ModelRecord.provider, ModelRecord.display_name)
    if not include_unavailable:
        stmt = stmt.where(ModelRecord.available.is_(True))
    return list((await db.scalars(stmt)).all())


def is_chat_model(rec: ModelRecord) -> bool:
    # Providers that don't report capabilities are assumed to be chat-capable.
    return not rec.capabilities or CHAT_CAPABILITY in rec.capabilities
