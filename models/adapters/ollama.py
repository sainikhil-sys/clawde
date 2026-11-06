"""Ollama adapter (https://github.com/ollama/ollama/blob/main/docs/api.md).

Ollama runs locally (default http://127.0.0.1:11434) and wraps llama.cpp, so this adapter makes no
internet requests. Model downloads (`/api/pull`) are a separate, network-gated feature (Milestone 11).
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Sequence
from datetime import datetime
from typing import Any

import httpx
import structlog

from core.inference.provider import ModelNotFound, ProviderError, ProviderUnavailable
from core.inference.types import (
    ChatMessage,
    GenerationDone,
    GenerationParams,
    ProviderModel,
    StreamEvent,
    TokenDelta,
)

log = structlog.get_logger("clawde.models.ollama")

_NS_PER_MS = 1_000_000


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _to_provider_model(raw: dict[str, Any]) -> ProviderModel:
    details = raw.get("details") or {}
    name = str(raw.get("model") or raw.get("name"))
    ctx = details.get("context_length")
    return ProviderModel(
        provider="ollama",
        ref=name,
        display_name=name,
        family=details.get("family") or None,
        parameter_size=details.get("parameter_size") or None,
        quantization=details.get("quantization_level") or None,
        format=details.get("format") or None,
        size_bytes=raw.get("size") if isinstance(raw.get("size"), int) else None,
        context_length=ctx if isinstance(ctx, int) else None,
        digest=raw.get("digest") or None,
        modified_at=_parse_time(raw.get("modified_at")),
        capabilities=tuple(str(c) for c in raw.get("capabilities") or ()),
    )


class OllamaProvider:
    name = "ollama"

    def __init__(
        self, base_url: str, *, client: httpx.AsyncClient | None = None, keep_alive: str = "10m"
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.keep_alive = keep_alive
        self._client = client or httpx.AsyncClient(
            base_url=self.base_url,
            # Cold-loading a 7B model on CPU can take ~25 s before the first token.
            timeout=httpx.Timeout(connect=3.0, read=300.0, write=30.0, pool=5.0),
            trust_env=False,  # never route local model traffic through a system proxy
        )

    async def is_available(self) -> bool:
        try:
            resp = await self._client.get("/api/version", timeout=2.0)
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def list_models(self) -> list[ProviderModel]:
        try:
            resp = await self._client.get("/api/tags", timeout=10.0)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Ollama is not reachable at {self.base_url}.") from exc
        if resp.status_code != 200:
            raise ProviderError(f"Ollama returned HTTP {resp.status_code} for /api/tags.")
        models = resp.json().get("models") or []
        return [_to_provider_model(m) for m in models]

    async def chat_stream(
        self, ref: str, messages: Sequence[ChatMessage], params: GenerationParams
    ) -> AsyncGenerator[StreamEvent]:
        options: dict[str, Any] = {
            "temperature": params.temperature,
            "top_p": params.top_p,
            "num_predict": params.max_tokens,
            "num_ctx": params.context_length,
        }
        if params.seed is not None:
            options["seed"] = params.seed
        payload = {
            "model": ref,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "options": options,
            "keep_alive": self.keep_alive,
        }
        if params.response_format == "json":
            payload["format"] = "json"
        try:
            async with self._client.stream("POST", "/api/chat", json=payload) as resp:
                if resp.status_code == 404:
                    raise ModelNotFound(
                        f"Ollama does not have model {ref!r}. Pull it with `ollama pull {ref}`."
                    )
                if resp.status_code != 200:
                    body = (await resp.aread()).decode(errors="replace")[:500]
                    raise ProviderError(f"Ollama returned HTTP {resp.status_code}: {_error_text(body)}")
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if "error" in chunk:
                        raise ProviderError(f"Ollama error: {chunk['error']}")
                    text = (chunk.get("message") or {}).get("content") or ""
                    if text:
                        yield TokenDelta(text)
                    if chunk.get("done"):
                        yield GenerationDone(
                            finish_reason=str(chunk.get("done_reason") or "stop"),
                            prompt_tokens=chunk.get("prompt_eval_count"),
                            completion_tokens=chunk.get("eval_count"),
                            total_duration_ms=_ms(chunk.get("total_duration")),
                            load_duration_ms=_ms(chunk.get("load_duration")),
                        )
                        return
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise ProviderUnavailable(f"Ollama is not reachable at {self.base_url}.") from exc
        except httpx.ReadTimeout as exc:
            raise ProviderError("Ollama stopped responding (read timeout).") from exc
        except httpx.HTTPError as exc:
            raise ProviderError(f"Connection to Ollama failed: {exc}") from exc
        raise ProviderError("Ollama closed the stream before finishing.")

    async def aclose(self) -> None:
        await self._client.aclose()


def _ms(ns: Any) -> float | None:
    return round(ns / _NS_PER_MS, 1) if isinstance(ns, int | float) else None


def _error_text(body: str) -> str:
    try:
        return str(json.loads(body).get("error", body))
    except (ValueError, AttributeError):
        return body
