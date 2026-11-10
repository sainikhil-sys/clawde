"""llama.cpp adapter: talks to a local `llama-server` through its OpenAI-compatible HTTP API.

Clawde doesn't download or start llama.cpp itself. Run `llama-server -m model.gguf --port 8080` (or with
`--models-dir` for several models) and set `CLAWDE_LLAMACPP_URL=http://127.0.0.1:8080`. Only loopback URLs are
accepted, so this adapter never sends prompts off the machine.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Sequence
from typing import Any
from urllib.parse import urlparse

import httpx
import structlog

from core.inference.provider import ModelNotFound, ProviderError, ProviderUnavailable
from core.inference.types import (
    ChatMessage,
    GenerationDone,
    GenerationParams,
    ModelDetails,
    ProviderModel,
    StreamEvent,
    TokenDelta,
)

log = structlog.get_logger("clawde.models.llamacpp")

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def check_loopback(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or (parsed.hostname or "") not in LOOPBACK_HOSTS:
        raise ValueError(f"llama.cpp URL must be a loopback http(s) address, got {url!r}")
    return url.rstrip("/")


class LlamaCppProvider:
    name = "llamacpp"

    def __init__(self, base_url: str, *, client: httpx.AsyncClient | None = None) -> None:
        self.base_url = check_loopback(base_url)
        self._client = client or httpx.AsyncClient(
            base_url=self.base_url,
            timeout=httpx.Timeout(connect=3.0, read=300.0, write=30.0, pool=5.0),
            trust_env=False,
        )

    async def is_available(self) -> bool:
        try:
            resp = await self._client.get("/health", timeout=2.0)
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def list_models(self) -> list[ProviderModel]:
        try:
            resp = await self._client.get("/v1/models", timeout=10.0)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"llama-server is not reachable at {self.base_url}.") from exc
        if resp.status_code != 200:
            raise ProviderError(f"llama-server returned HTTP {resp.status_code} for /v1/models.")
        out = []
        for m in resp.json().get("data") or []:
            ref = str(m.get("id"))
            meta: dict[str, Any] = m.get("meta") or {}
            ctx = meta.get("n_ctx_train")
            size = meta.get("size")
            out.append(
                ProviderModel(
                    provider=self.name,
                    ref=ref,
                    display_name=ref.rsplit("/", 1)[-1].rsplit("\\", 1)[-1],
                    format="gguf",
                    size_bytes=int(size) if isinstance(size, int | float) else None,
                    context_length=int(ctx) if isinstance(ctx, int | float) else None,
                    # llama-server serves chat; embeddings only if started with --embeddings.
                    capabilities=("completion",),
                )
            )
        return out

    async def details(self, ref: str) -> ModelDetails | None:
        """llama-server reports few fields: parameter count and training context come from /v1/models."""
        try:
            resp = await self._client.get("/v1/models", timeout=10.0)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"llama-server is not reachable at {self.base_url}.") from exc
        for m in resp.json().get("data") or [] if resp.status_code == 200 else []:
            if str(m.get("id")) == ref:
                meta: dict[str, Any] = m.get("meta") or {}
                params = meta.get("n_params")
                ctx = meta.get("n_ctx_train")
                return ModelDetails(
                    parameter_count=int(params) if isinstance(params, int | float) else None,
                    context_length=int(ctx) if isinstance(ctx, int | float) else None,
                    embedding_length=meta.get("n_embd") if isinstance(meta.get("n_embd"), int) else None,
                )
        return None

    async def chat_stream(
        self, ref: str, messages: Sequence[ChatMessage], params: GenerationParams
    ) -> AsyncGenerator[StreamEvent]:
        payload: dict[str, Any] = {
            "model": ref,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "temperature": params.temperature,
            "top_p": params.top_p,
            "max_tokens": params.max_tokens,
            "stream_options": {"include_usage": True},
        }
        if params.seed is not None:
            payload["seed"] = params.seed
        if params.response_format == "json":
            payload["response_format"] = {"type": "json_object"}
        finish: str | None = None
        usage: dict[str, Any] = {}
        try:
            async with self._client.stream("POST", "/v1/chat/completions", json=payload) as resp:
                if resp.status_code == 404:
                    raise ModelNotFound(f"llama-server has no model {ref!r}.")
                if resp.status_code != 200:
                    body = (await resp.aread()).decode(errors="replace")[:500]
                    raise ProviderError(f"llama-server returned HTTP {resp.status_code}: {_error_text(body)}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    if "error" in chunk:
                        raise ProviderError(f"llama-server error: {_error_text(json.dumps(chunk))}")
                    if chunk.get("usage"):
                        usage = chunk["usage"]
                    for choice in chunk.get("choices") or []:
                        text = (choice.get("delta") or {}).get("content") or ""
                        if text:
                            yield TokenDelta(text)
                        if choice.get("finish_reason"):
                            finish = str(choice["finish_reason"])
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise ProviderUnavailable(f"llama-server is not reachable at {self.base_url}.") from exc
        except httpx.ReadTimeout as exc:
            raise ProviderError("llama-server stopped responding (read timeout).") from exc
        except httpx.HTTPError as exc:
            raise ProviderError(f"Connection to llama-server failed: {exc}") from exc
        if finish is None:
            raise ProviderError("llama-server closed the stream before finishing.")
        yield GenerationDone(
            finish_reason=finish,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
        )

    async def embed(self, ref: str, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            resp = await self._client.post(
                "/v1/embeddings", json={"model": ref, "input": list(texts)}, timeout=120.0
            )
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"llama-server is not reachable at {self.base_url}.") from exc
        if resp.status_code != 200:
            raise ProviderError(
                f"llama-server embeddings failed ({_error_text(resp.text[:300])}). "
                "Start it with --embeddings."
            )
        data = sorted(resp.json().get("data") or [], key=lambda d: d.get("index", 0))
        if len(data) != len(texts):
            raise ProviderError("llama-server returned the wrong number of embeddings.")
        return [[float(x) for x in d["embedding"]] for d in data]

    async def aclose(self) -> None:
        await self._client.aclose()


def _error_text(body: str) -> str:
    try:
        err = json.loads(body).get("error", body)
        return str(err.get("message", err)) if isinstance(err, dict) else str(err)
    except (ValueError, AttributeError):
        return body
