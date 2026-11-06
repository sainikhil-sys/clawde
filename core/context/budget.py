"""Fit conversation history into a model's context window.

This is the Milestone 4 baseline: keep the system prompt and the newest messages that fit, dropping the
oldest first. Milestone 8 replaces dropped history with rolling summaries and retrieved memory.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

from core.inference.types import ChatMessage

#: Conservative characters-per-token estimate for English/code with Llama/Qwen-style tokenizers.
CHARS_PER_TOKEN = 3.5
#: Per-message overhead for chat template role markers.
MESSAGE_OVERHEAD_TOKENS = 4


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS


def fit_history(
    messages: Sequence[ChatMessage], *, context_length: int, reserve_for_output: int
) -> tuple[list[ChatMessage], int]:
    """Return (messages to send, number dropped). System messages are always kept.

    The newest message is always kept even if it alone exceeds the budget; the backend then truncates.
    """
    budget = max(context_length - reserve_for_output, context_length // 4)
    system = [m for m in messages if m.role == "system"]
    rest = [m for m in messages if m.role != "system"]
    used = sum(estimate_tokens(m.content) for m in system)

    kept: list[ChatMessage] = []
    for msg in reversed(rest):
        cost = estimate_tokens(msg.content)
        if kept and used + cost > budget:
            break
        kept.append(msg)
        used += cost
    kept.reverse()
    return system + kept, len(rest) - len(kept)
