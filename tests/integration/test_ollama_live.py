"""Against the real local Ollama server. Skipped automatically when Ollama is not running.

Picks the smallest installed chat model, so no model name is hardcoded. Run only these with:
    uv run pytest -m live
"""

from __future__ import annotations

import os
import time

import httpx
import pytest

from core.inference.types import ChatMessage, GenerationDone, GenerationParams, TokenDelta
from models.adapters.ollama import OllamaProvider

OLLAMA_URL = os.environ.get("CLAWDE_OLLAMA_URL", "http://127.0.0.1:11434")

pytestmark = pytest.mark.live


def _ollama_running() -> bool:
    try:
        return httpx.get(f"{OLLAMA_URL}/api/version", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


@pytest.fixture
async def ollama() -> OllamaProvider:
    if not _ollama_running():
        pytest.skip(f"Ollama not reachable at {OLLAMA_URL}")
    return OllamaProvider(OLLAMA_URL, keep_alive="2m")


async def _smallest_chat_model(p: OllamaProvider) -> str:
    models = [m for m in await p.list_models() if "completion" in m.capabilities or not m.capabilities]
    if not models:
        pytest.skip("No chat models installed in Ollama")
    return min(models, key=lambda m: m.size_bytes or 0).ref


async def test_live_streaming_reply(ollama: OllamaProvider) -> None:
    ref = await _smallest_chat_model(ollama)
    params = GenerationParams(temperature=0, max_tokens=24, context_length=2048, seed=7)
    tokens: list[str] = []
    done: GenerationDone | None = None
    async for ev in ollama.chat_stream(ref, [ChatMessage("user", "Reply with exactly: ok")], params):
        if isinstance(ev, TokenDelta):
            tokens.append(ev.text)
        else:
            done = ev
    await ollama.aclose()
    assert len(tokens) >= 1, "expected at least one streamed token"
    assert done is not None
    assert done.completion_tokens is not None and done.completion_tokens <= 24
    assert done.prompt_tokens is not None and done.prompt_tokens > 0


async def test_live_cancel_stops_generation(ollama: OllamaProvider) -> None:
    ref = await _smallest_chat_model(ollama)
    params = GenerationParams(temperature=0.7, max_tokens=400, context_length=2048)
    stream = ollama.chat_stream(ref, [ChatMessage("user", "Write a long story about the sea.")], params)
    count = 0
    async for ev in stream:
        if isinstance(ev, TokenDelta):
            count += 1
            if count == 3:
                break
    t0 = time.perf_counter()
    await stream.aclose()  # closes the HTTP response, which makes Ollama stop generating
    assert time.perf_counter() - t0 < 2.0

    # The server stays healthy and immediately serves a new request.
    short = GenerationParams(temperature=0, max_tokens=4, context_length=2048)
    events = [ev async for ev in ollama.chat_stream(ref, [ChatMessage("user", "hi")], short)]
    await ollama.aclose()
    assert isinstance(events[-1], GenerationDone)
