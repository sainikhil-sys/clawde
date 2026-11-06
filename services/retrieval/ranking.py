"""Relevance ranking for document passages: BM25 keyword scoring, optionally blended with embeddings.

BM25 needs no model and works fully offline. When a local embedding model is available, cosine similarity
is blended in so paraphrased questions still find the right passage. Milestone 7 moves vectors into FAISS
indexes per project; the scoring contract here stays the same.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Sequence

_TOKEN = re.compile(r"[^\W_]+", re.UNICODE)
#: Very common English words carry no signal for matching.
_STOPWORDS = frozenset(
    [
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "but",
        "by",
        "for",
        "from",
        "has",
        "have",
        "how",
        "i",
        "in",
        "is",
        "it",
        "its",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "was",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "you",
        "your",
        "can",
        "do",
        "does",
        "did",
        "not",
        "about",
        "into",
        "than",
        "then",
        "there",
        "these",
        "those",
    ]
)


def tokenize(text: str) -> list[str]:
    return [
        t for t in (m.group().lower() for m in _TOKEN.finditer(text)) if t not in _STOPWORDS and len(t) > 1
    ]


def bm25_scores(query: str, documents: Sequence[str], *, k1: float = 1.5, b: float = 0.75) -> list[float]:
    q_terms = set(tokenize(query))
    if not q_terms or not documents:
        return [0.0] * len(documents)
    tokenized = [tokenize(d) for d in documents]
    n = len(tokenized)
    avg_len = sum(len(t) for t in tokenized) / n or 1.0
    df = Counter(term for toks in tokenized for term in set(toks))
    scores: list[float] = []
    for toks in tokenized:
        tf = Counter(toks)
        length = len(toks)
        score = 0.0
        for term in q_terms:
            if term not in tf:
                continue
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            freq = tf[term]
            score += idf * freq * (k1 + 1) / (freq + k1 * (1 - b + b * length / avg_len))
        scores.append(score)
    return scores


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _normalize(values: list[float]) -> list[float]:
    hi = max(values, default=0.0)
    lo = min(values, default=0.0)
    if hi - lo < 1e-12:
        return [0.0 for _ in values]
    return [(v - lo) / (hi - lo) for v in values]


def rank(
    query: str,
    passages: Sequence[str],
    *,
    passage_vectors: Sequence[Sequence[float] | None] | None = None,
    query_vector: Sequence[float] | None = None,
    vector_weight: float = 0.6,
) -> list[float]:
    """Combined relevance per passage in [0, 1]. Without vectors this is normalized BM25."""
    lexical = _normalize(bm25_scores(query, passages))
    if query_vector is None or passage_vectors is None:
        return lexical
    semantic = _normalize([cosine(query_vector, v) if v else 0.0 for v in passage_vectors])
    return [(1 - vector_weight) * lx + vector_weight * se for lx, se in zip(lexical, semantic, strict=True)]
