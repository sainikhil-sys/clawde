"""Ollama adapter against a scripted HTTP transport (wire-format parsing and error mapping)."""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from core.inference.provider import ModelNotFound, ProviderError, ProviderUnavailable
from core.inference.types import ChatMessage, GenerationDone, GenerationParams, TokenDelta
from models.adapters.ollama import OllamaProvider

TAGS = {
    "models": [
        {
            "name": "llama3.2:latest",
            "model": "llama3.2:latest",
            "modified_at": "2026-07-21T01:04:44.1306651+05:30",
            "size": 2019393189,
            "digest": "a80c4f17acd5",
            "details": {
                "format": "gguf",
                "family": "llama",
                "parameter_size": "3.2B",
                "quantization_level": "Q4_K_M",
                "context_length": 131072,
            },
            "capabilities": ["completion", "tools"],
        },
        {
            "name": "nomic-embed-text:latest",
            "model": "nomic-embed-text:latest",
            "details": {},
            "capabilities": ["embedding"],
        },
    ]
}


def ndjson(*chunks: dict[str, object]) -> bytes:
    return b"".join(json.dumps(c).encode() + b"\n" for c in chunks)


def provider_with(handler: Callable[[httpx.Request], httpx.Response]) -> OllamaProvider:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://127.0.0.1:11434")
    return OllamaProvider("http://127.0.0.1:11434", client=client)


async def collect(p: OllamaProvider) -> list[object]:
    return [
        ev async for ev in p.chat_stream("llama3.2:latest", [ChatMessage("user", "hi")], GenerationParams())
    ]


async def test_list_models_maps_metadata() -> None:
    p = provider_with(lambda req: httpx.Response(200, json=TAGS))
    models = await p.list_models()
    llama = models[0]
    assert llama.model_id == "ollama:llama3.2:latest"
    assert (llama.family, llama.parameter_size, llama.quantization, llama.format) == (
        "llama",
        "3.2B",
        "Q4_K_M",
        "gguf",
    )
    assert llama.context_length == 131072
    assert llama.size_bytes == 2019393189
    assert llama.capabilities == ("completion", "tools")
    assert llama.modified_at is not None
    assert models[1].capabilities == ("embedding",)


async def test_chat_stream_parses_tokens_and_usage() -> None:
    seen: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(json.loads(req.content))
        return httpx.Response(
            200,
            content=ndjson(
                {"message": {"role": "assistant", "content": "Hel"}, "done": False},
                {"message": {"role": "assistant", "content": "lo"}, "done": False},
                {
                    "message": {"role": "assistant", "content": ""},
                    "done": True,
                    "done_reason": "length",
                    "prompt_eval_count": 31,
                    "eval_count": 2,
                    "total_duration": 6_961_049_400,
                    "load_duration": 6_145_988_800,
                },
            ),
        )

    events = await collect(provider_with(handler))
    assert events[:2] == [TokenDelta("Hel"), TokenDelta("lo")]
    done = events[2]
    assert isinstance(done, GenerationDone)
    assert (done.finish_reason, done.prompt_tokens, done.completion_tokens) == ("length", 31, 2)
    assert done.total_duration_ms == 6961.0
    # Params are mapped to Ollama option names.
    assert seen["stream"] is True
    assert seen["options"] == {"temperature": 0.7, "top_p": 0.9, "num_predict": 1024, "num_ctx": 4096}


async def test_404_maps_to_model_not_found() -> None:
    p = provider_with(lambda req: httpx.Response(404, json={"error": "model not found"}))
    with pytest.raises(ModelNotFound):
        await collect(p)


async def test_error_line_mid_stream() -> None:
    body = ndjson({"message": {"content": "a"}, "done": False}, {"error": "out of memory"})
    p = provider_with(lambda req: httpx.Response(200, content=body))
    with pytest.raises(ProviderError, match="out of memory"):
        await collect(p)


async def test_stream_ending_without_done_is_an_error() -> None:
    p = provider_with(
        lambda req: httpx.Response(200, content=ndjson({"message": {"content": "a"}, "done": False}))
    )
    with pytest.raises(ProviderError, match="before finishing"):
        await collect(p)


async def test_connection_refused_is_unavailable() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    p = provider_with(handler)
    with pytest.raises(ProviderUnavailable):
        await p.list_models()
    with pytest.raises(ProviderUnavailable):
        await collect(p)
    assert await p.is_available() is False


async def test_http_500_on_chat() -> None:
    p = provider_with(lambda req: httpx.Response(500, json={"error": "llama runner crashed"}))
    with pytest.raises(ProviderError, match="llama runner crashed"):
        await collect(p)
