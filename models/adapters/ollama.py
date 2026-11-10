"""Ollama adapter (https://github.com/ollama/ollama/blob/main/docs/api.md).

Ollama runs locally (default http://127.0.0.1:11434) and wraps llama.cpp, so this adapter makes no
internet requests, except `pull`, which downloads from the Ollama registry and is only called after the app's
network gate allows it (services/network).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import structlog

from core.inference.provider import ModelNotFound, ProviderError, ProviderUnavailable
from core.inference.types import (
    ChatMessage,
    GenerationDone,
    GenerationParams,
    LoadedModel,
    ModelDetails,
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
            "messages": [_message(m) for m in messages],
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

    async def embed(self, ref: str, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            resp = await self._client.post(
                "/api/embed", json={"model": ref, "input": list(texts)}, timeout=120.0
            )
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Ollama is not reachable at {self.base_url}.") from exc
        if resp.status_code == 404:
            raise ModelNotFound(f"Ollama does not have embedding model {ref!r}.")
        if resp.status_code != 200:
            raise ProviderError(f"Ollama embed failed: {_error_text(resp.text[:500])}")
        vectors = resp.json().get("embeddings") or []
        if len(vectors) != len(texts):
            raise ProviderError("Ollama returned the wrong number of embeddings.")
        return [[float(x) for x in v] for v in vectors]

    # ---- Library management (Milestone 11) ----

    async def details(self, ref: str) -> ModelDetails | None:
        """Architecture, size, licence and layer shapes from /api/show."""
        try:
            resp = await self._client.post("/api/show", json={"model": ref}, timeout=30.0)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Ollama is not reachable at {self.base_url}.") from exc
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise ProviderError(f"Ollama show failed: {_error_text(resp.text[:500])}")
        return parse_show(resp.json())

    async def loaded(self) -> list[LoadedModel]:
        try:
            resp = await self._client.get("/api/ps", timeout=5.0)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Ollama is not reachable at {self.base_url}.") from exc
        if resp.status_code != 200:
            raise ProviderError(f"Ollama ps failed: HTTP {resp.status_code}")
        out = []
        for m in resp.json().get("models") or []:
            out.append(
                LoadedModel(
                    ref=str(m.get("model") or m.get("name")),
                    size_bytes=int(m.get("size") or 0),
                    vram_bytes=int(m.get("size_vram") or 0),
                    expires_at=_parse_time(m.get("expires_at")),
                )
            )
        return out

    async def unload(self, ref: str) -> None:
        """Free a model's memory now (keep_alive 0)."""
        try:
            resp = await self._client.post(
                "/api/generate", json={"model": ref, "keep_alive": 0}, timeout=30.0
            )
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Ollama is not reachable at {self.base_url}.") from exc
        if resp.status_code not in (200, 404):
            raise ProviderError(f"Ollama unload failed: {_error_text(resp.text[:500])}")

    async def delete(self, ref: str) -> None:
        try:
            resp = await self._client.request("DELETE", "/api/delete", json={"model": ref}, timeout=60.0)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"Ollama is not reachable at {self.base_url}.") from exc
        if resp.status_code == 404:
            raise ModelNotFound(f"Ollama does not have model {ref!r}.")
        if resp.status_code != 200:
            raise ProviderError(f"Ollama delete failed: {_error_text(resp.text[:500])}")

    async def pull(self, name: str) -> AsyncIterator[dict[str, Any]]:
        """Download a model from the Ollama registry, yielding progress: {status, completed?, total?}.

        Internet access: callers must check the network gate first."""
        try:
            async with self._client.stream(
                "POST",
                "/api/pull",
                json={"model": name, "stream": True},
                timeout=httpx.Timeout(30.0, read=None),
            ) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode(errors="replace")[:500]
                    raise ProviderError(f"Pull failed: {_error_text(body)}")
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if "error" in chunk:
                        raise ProviderError(f"Pull failed: {chunk['error']}")
                    yield chunk
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise ProviderUnavailable(f"Ollama is not reachable at {self.base_url}.") from exc

    async def import_gguf(self, name: str, path: Path) -> AsyncIterator[dict[str, Any]]:
        """Register a local .gguf file as an Ollama model (copied into Ollama's local blob store; offline)."""
        digest = "sha256:" + await asyncio.to_thread(_sha256_file, path)
        try:
            head = await self._client.head(f"/api/blobs/{digest}", timeout=30.0)
            if head.status_code != 200:
                yield {"status": "copying model file into Ollama"}
                size = (await asyncio.to_thread(path.stat)).st_size

                async def body() -> AsyncIterator[bytes]:
                    with path.open("rb") as fh:
                        while chunk := await asyncio.to_thread(fh.read, 4 * 1024 * 1024):
                            yield chunk

                resp = await self._client.post(
                    f"/api/blobs/{digest}",
                    content=body(),
                    headers={"Content-Length": str(size)},
                    timeout=httpx.Timeout(30.0, write=None, read=600.0),
                )
                if resp.status_code not in (200, 201):
                    raise ProviderError(
                        f"Uploading the file to Ollama failed: {_error_text(resp.text[:500])}"
                    )
            payload = {"model": name, "files": {path.name: digest}, "stream": True}
            async with self._client.stream(
                "POST", "/api/create", json=payload, timeout=httpx.Timeout(30.0, read=None)
            ) as resp:
                if resp.status_code != 200:
                    raise ProviderError(
                        f"Creating the model failed: {_error_text((await resp.aread()).decode()[:500])}"
                    )
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if "error" in chunk:
                        raise ProviderError(f"Creating the model failed: {chunk['error']}")
                    yield chunk
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise ProviderUnavailable(f"Ollama is not reachable at {self.base_url}.") from exc

    async def aclose(self) -> None:
        await self._client.aclose()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(4 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def parse_show(data: dict[str, Any]) -> ModelDetails:
    """Pull the useful fields out of an /api/show response."""
    info: dict[str, Any] = data.get("model_info") or {}
    arch = info.get("general.architecture") or (data.get("details") or {}).get("family")

    def arch_int(key: str) -> int | None:
        value = info.get(f"{arch}.{key}") if arch else None
        if isinstance(value, list):  # some models give per-layer values
            value = max((v for v in value if isinstance(v, int)), default=None)
        return int(value) if isinstance(value, int | float) else None

    license_text = data.get("license")
    if isinstance(license_text, list):
        license_text = "\n\n".join(str(x) for x in license_text)
    license_text = str(license_text).strip() if license_text else None
    params = info.get("general.parameter_count")
    return ModelDetails(
        architecture=str(arch) if arch else None,
        parameter_count=int(params) if isinstance(params, int | float) else None,
        license=license_name(license_text, info.get("general.license")),
        license_text=license_text,
        context_length=arch_int("context_length"),
        layers=arch_int("block_count"),
        embedding_length=arch_int("embedding_length"),
        head_count=arch_int("attention.head_count"),
        head_count_kv=arch_int("attention.head_count_kv"),
    )


def license_name(text: str | None, declared: Any = None) -> str | None:
    """A short label for a licence: a declared id if present, else the first meaningful line of the text."""
    if isinstance(declared, str) and declared.strip():
        return declared.strip()[:200]
    if not text:
        return None
    for line in text.splitlines():
        line = line.strip().strip("#").strip()
        if len(line) >= 3:
            return line[:200]
    return None


def _message(m: ChatMessage) -> dict[str, Any]:
    out: dict[str, Any] = {"role": m.role, "content": m.content}
    if m.images:
        out["images"] = [base64.b64encode(img).decode("ascii") for img in m.images]
    return out


def _ms(ns: Any) -> float | None:
    return round(ns / _NS_PER_MS, 1) if isinstance(ns, int | float) else None


def _error_text(body: str) -> str:
    try:
        return str(json.loads(body).get("error", body))
    except (ValueError, AttributeError):
        return body
