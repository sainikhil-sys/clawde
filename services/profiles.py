"""Behaviour profiles: which one applies to a chat, and how it changes the request.

Precedence (most specific wins): conversation, then project, then model. A profile adds its instructions to
the system prompt and supplies sampling defaults; settings the user changes in a chat still take priority.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from core.inference.types import GenerationParams
from storage.database.models import BehaviourProfile, Conversation, ModelRecord, Project


@dataclass(frozen=True, slots=True)
class Effective:
    profile: BehaviourProfile
    #: Where it came from: conversation | project | model
    source: str


async def effective(
    db: AsyncSession, *, conversation: Conversation | None, project: Project | None, model: ModelRecord | None
) -> Effective | None:
    for source, owner in (("conversation", conversation), ("project", project), ("model", model)):
        pid = getattr(owner, "behaviour_profile_id", None) if owner is not None else None
        if pid:
            profile = await db.get(BehaviourProfile, pid)
            if profile is not None:
                return Effective(profile, source)
    return None


def apply_params(base: GenerationParams, profile: BehaviourProfile | None) -> GenerationParams:
    """Profile sampling defaults over the app defaults (used when the chat didn't send its own settings)."""
    if profile is None:
        return base
    update = {
        k: v
        for k, v in {
            "temperature": profile.temperature,
            "top_p": profile.top_p,
            "max_tokens": profile.max_tokens,
            "context_length": profile.context_length,
        }.items()
        if v is not None
    }
    return base.model_copy(update=update)


def instructions(eff: Effective | None) -> str:
    if eff is None or not eff.profile.system_prompt.strip():
        return ""
    name = eff.profile.name
    return f'Instructions from the user\'s behaviour profile "{name}":\n{eff.profile.system_prompt.strip()}'
