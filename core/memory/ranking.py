"""Rank saved memories for a turn and pick what fits the memory budget.

Pure functions (no database, no model) so the policy is easy to test and explain:

    score = 0.60 * relevance + 0.25 * importance + 0.15 * recency      (each in [0, 1])

- relevance: BM25 against the user's latest message, divided by the best BM25 among candidates, blended with
  cosine similarity when both sides have vectors from the same embedding model.
- importance: the user's 1-5 rating, scaled to [0, 1].
- recency: halves every 30 days since the memory was last edited or used.

Eligibility: pinned memories, preferences and this conversation's temporary context are always eligible.
Everything else must actually relate to the message (relevance at or above ``MIN_RELEVANCE``), so unrelated
notes never take up context. Pinned memories are placed first, then by score, until the token budget is spent.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime

from core.context.budget import estimate_tokens
from services.retrieval.ranking import bm25_scores, cosine

MIN_RELEVANCE = 0.2
#: Cosine below this counts as unrelated (typical for small sentence-embedding models).
COSINE_FLOOR = 0.35
HALF_LIFE_DAYS = 30.0
WEIGHTS = (0.60, 0.25, 0.15)
#: A long knowledge memory may contribute several passages, other memories one.
MAX_PASSAGES_PER_MEMORY = 3
MAX_MEMORIES = 12


@dataclass(frozen=True, slots=True)
class Candidate:
    id: str
    kind: str
    title: str
    passages: Sequence[str]
    importance: int
    pinned: bool
    always: bool
    updated_at: datetime
    last_used_at: datetime | None = None
    vectors: Sequence[Sequence[float]] | None = None


@dataclass(frozen=True, slots=True)
class Scored:
    id: str
    kind: str
    title: str
    passage: int
    text: str
    relevance: float
    importance: float
    recency: float
    score: float
    pinned: bool
    always: bool


@dataclass(slots=True)
class Selection:
    chosen: list[Scored] = field(default_factory=list)
    #: Eligible passages left out because the budget ran out.
    skipped_for_budget: int = 0
    tokens: int = 0

    @property
    def memory_ids(self) -> list[str]:
        return list(dict.fromkeys(s.id for s in self.chosen))


def recency(updated_at: datetime, last_used_at: datetime | None, now: datetime) -> float:
    latest = max(updated_at, last_used_at) if last_used_at else updated_at
    age_days = max(0.0, (now - latest).total_seconds() / 86_400)
    return float(0.5 ** (age_days / HALF_LIFE_DAYS))


def score_candidates(
    query: str,
    candidates: Sequence[Candidate],
    *,
    now: datetime,
    query_vector: Sequence[float] | None = None,
) -> list[Scored]:
    """Score every passage of every candidate. Ineligible passages are dropped; best first."""
    flat: list[tuple[Candidate, int, str]] = [
        (c, i, f"{c.title}\n{p}" if c.title and i == 0 else p)
        for c in candidates
        for i, p in enumerate(c.passages)
    ]
    if not flat:
        return []
    lexical = bm25_scores(query, [text for _, _, text in flat])
    best = max(lexical, default=0.0)
    out: list[Scored] = []
    for (c, i, _), lx in zip(flat, lexical, strict=True):
        rel = lx / best if best > 0 else 0.0
        if query_vector is not None and c.vectors is not None and i < len(c.vectors):
            sim = cosine(query_vector, c.vectors[i])
            semantic = max(0.0, (sim - COSINE_FLOOR) / (1 - COSINE_FLOOR))
            rel = 0.4 * rel + 0.6 * semantic
        if not (c.pinned or c.always) and rel < MIN_RELEVANCE:
            continue
        imp = (min(max(c.importance, 1), 5) - 1) / 4
        rec = recency(c.updated_at, c.last_used_at, now)
        total = WEIGHTS[0] * rel + WEIGHTS[1] * imp + WEIGHTS[2] * rec
        out.append(
            Scored(
                id=c.id,
                kind=c.kind,
                title=c.title,
                passage=i,
                text=c.passages[i],
                relevance=round(rel, 4),
                importance=round(imp, 4),
                recency=round(rec, 4),
                score=round(total, 4),
                pinned=c.pinned,
                always=c.always,
            )
        )
    out.sort(key=lambda s: (not s.pinned, -s.score))
    return out


def select(scored: Sequence[Scored], *, token_budget: int) -> Selection:
    """Take passages in rank order while they fit. Order within the result is rank order."""
    sel = Selection()
    per_memory: dict[str, int] = {}
    for s in scored:
        n = per_memory.get(s.id, 0)
        limit = MAX_PASSAGES_PER_MEMORY if s.kind == "knowledge" else 1
        if n >= limit or (n == 0 and len(per_memory) >= MAX_MEMORIES):
            continue
        cost = estimate_tokens(s.text) + (estimate_tokens(s.title) if s.title else 0)
        if sel.tokens + cost > token_budget:
            sel.skipped_for_budget += 1
            continue
        sel.chosen.append(s)
        sel.tokens += cost
        per_memory[s.id] = n + 1
    return sel


def memory_budget(available_tokens: int, *, share: float = 0.2, cap: int = 1500) -> int:
    """Tokens memory may use out of what's left after history and output reserve."""
    return max(0, min(cap, math.floor(available_tokens * share)))
