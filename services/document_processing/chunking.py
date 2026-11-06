"""Split extracted text into overlapping passages along paragraph and sentence boundaries."""

from __future__ import annotations

import re
from dataclasses import dataclass

DEFAULT_CHUNK_CHARS = 1200
DEFAULT_OVERLAP_CHARS = 150


@dataclass(frozen=True, slots=True)
class Chunk:
    ordinal: int
    start: int
    end: int
    text: str


_BREAKS = (re.compile(r"\n\s*\n"), re.compile(r"\n"), re.compile(r"(?<=[.!?])\s+"), re.compile(r"\s+"))


def _best_break(text: str, lo: int, hi: int) -> int:
    """Latest natural boundary in text[lo:hi], preferring paragraphs over lines over sentences over spaces."""
    window = text[lo:hi]
    for pattern in _BREAKS:
        matches = list(pattern.finditer(window))
        if matches:
            return lo + matches[-1].end()
    return hi


def chunk_text(
    text: str, *, size: int = DEFAULT_CHUNK_CHARS, overlap: int = DEFAULT_OVERLAP_CHARS
) -> list[Chunk]:
    if overlap >= size:
        raise ValueError("overlap must be smaller than size")
    chunks: list[Chunk] = []
    n = len(text)
    start = 0
    while start < n:
        hard_end = min(start + size, n)
        end = hard_end if hard_end == n else _best_break(text, start + size // 2, hard_end)
        piece = text[start:end].strip()
        if piece:
            chunks.append(Chunk(len(chunks), start, end, piece))
        if end >= n:
            break
        start = max(end - overlap, start + 1)
        # Don't start mid-word: move to the next whitespace inside the overlap.
        ws = re.search(r"\s", text[start:end])
        if ws:
            start += ws.end()
    return chunks
