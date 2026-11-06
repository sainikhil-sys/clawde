from __future__ import annotations

from core.context.budget import estimate_tokens, fit_history
from core.inference.types import ChatMessage


def test_everything_fits() -> None:
    msgs = [ChatMessage("user", "hi"), ChatMessage("assistant", "hello"), ChatMessage("user", "how are you")]
    kept, dropped = fit_history(msgs, context_length=4096, reserve_for_output=512)
    assert kept == msgs
    assert dropped == 0


def test_drops_oldest_first_and_keeps_system() -> None:
    system = ChatMessage("system", "be brief")
    old = [ChatMessage("user" if i % 2 == 0 else "assistant", "x" * 700) for i in range(10)]
    newest = ChatMessage("user", "latest question")
    kept, dropped = fit_history([system, *old, newest], context_length=1024, reserve_for_output=256)
    assert kept[0] == system
    assert kept[-1] == newest
    assert dropped > 0
    assert sum(estimate_tokens(m.content) for m in kept) <= 1024 - 256
    # Kept history is the most recent contiguous run.
    assert kept[1:-1] == old[len(old) - (len(kept) - 2) :]


def test_newest_message_always_kept_even_if_huge() -> None:
    huge = ChatMessage("user", "y" * 100_000)
    kept, dropped = fit_history(
        [ChatMessage("user", "old"), huge], context_length=2048, reserve_for_output=512
    )
    assert kept == [huge]
    assert dropped == 1
