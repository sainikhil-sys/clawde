"""Hugging Face Transformers adapter: small models in-process on CPU.

Models live in `<data_dir>/models/hf/<name>/` (config.json + *.safetensors + tokenizer files), put there by
the Model Library's Hugging Face download (network-gated) or copied in by the user. For safety, only
safetensors weights are loaded and `trust_remote_code` is never enabled, so a model folder can't run its own
Python code.

Needs the optional `ml` extra (`uv sync --extra ml`: PyTorch CPU + Transformers). Without it the provider
reports itself unavailable with that instruction. One model is kept in memory at a time; CPU inference is only
practical for small models (about 1.5B parameters or less).
"""

from __future__ import annotations

import asyncio
import gc
import importlib.util
import threading
from collections.abc import AsyncGenerator, Sequence
from pathlib import Path
from typing import Any

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
from services.model_files import ModelFileError, read_hf_folder

log = structlog.get_logger("clawde.models.transformers")

INSTALL_HINT = (
    "Transformers isn't installed. Install it with `uv sync --extra ml` (CPU PyTorch + Transformers)."
)


def ml_installed() -> bool:
    return (
        importlib.util.find_spec("torch") is not None and importlib.util.find_spec("transformers") is not None
    )


class _Loaded:
    def __init__(self, ref: str, model: Any, tokenizer: Any, size: int) -> None:
        self.ref = ref
        self.model = model
        self.tokenizer = tokenizer
        self.size = size


class TransformersProvider:
    name = "transformers"

    def __init__(self, models_dir: Path) -> None:
        self.models_dir = models_dir
        self._loaded: _Loaded | None = None
        self._lock = asyncio.Lock()

    def _folder(self, ref: str) -> Path:
        # Refs are folder names directly under models_dir; nothing else is reachable.
        if not ref or "/" in ref or "\\" in ref or ref in (".", "..") or ref.startswith("."):
            raise ModelNotFound(f"No local Transformers model {ref!r}.")
        folder = self.models_dir / ref
        if not (folder / "config.json").is_file():
            raise ModelNotFound(f"No local Transformers model {ref!r}.")
        return folder

    async def is_available(self) -> bool:
        return ml_installed()

    async def list_models(self) -> list[ProviderModel]:
        if not ml_installed():
            raise ProviderUnavailable(INSTALL_HINT)
        return await asyncio.to_thread(self._scan)

    def _scan(self) -> list[ProviderModel]:
        out: list[ProviderModel] = []
        if not self.models_dir.is_dir():
            return out
        for folder in sorted(self.models_dir.iterdir()):
            if not folder.is_dir() or folder.name.startswith("."):
                continue
            try:
                info = read_hf_folder(folder)
            except ModelFileError:
                continue
            causal = (info.architecture or "").endswith(("ForCausalLM", "LMHeadModel"))
            out.append(
                ProviderModel(
                    provider=self.name,
                    ref=folder.name,
                    display_name=folder.name,
                    family=info.architecture,
                    format="safetensors",
                    size_bytes=info.size_bytes,
                    context_length=info.context_length if isinstance(info.context_length, int) else None,
                    capabilities=("completion",) if causal else (),
                )
            )
        return out

    async def details(self, ref: str) -> ModelDetails | None:
        try:
            info = await asyncio.to_thread(read_hf_folder, self._folder(ref))
        except (ModelFileError, ModelNotFound):
            return None
        d = info.details
        return ModelDetails(
            architecture=info.architecture,
            license=info.license,
            context_length=info.context_length if isinstance(info.context_length, int) else None,
            layers=d.get("layers"),
            embedding_length=d.get("embedding_length"),
            head_count=d.get("head_count"),
            head_count_kv=d.get("head_count_kv"),
        )

    async def loaded(self) -> list[LoadedModel]:
        return [LoadedModel(self._loaded.ref, self._loaded.size)] if self._loaded else []

    async def unload(self, ref: str) -> None:
        if self._loaded and self._loaded.ref == ref:
            self._loaded = None
            gc.collect()

    def _load(self, ref: str) -> _Loaded:
        from transformers import AutoModelForCausalLM, AutoTokenizer

        folder = self._folder(ref)
        tokenizer = AutoTokenizer.from_pretrained(folder, local_files_only=True, trust_remote_code=False)
        model = AutoModelForCausalLM.from_pretrained(
            folder, local_files_only=True, trust_remote_code=False, use_safetensors=True, torch_dtype="auto"
        )
        model.eval()  # type: ignore[no-untyped-call,unused-ignore]
        size = sum(p.numel() * p.element_size() for p in model.parameters())
        return _Loaded(ref, model, tokenizer, int(size))

    async def _ensure(self, ref: str) -> _Loaded:
        if self._loaded and self._loaded.ref == ref:
            return self._loaded
        self._loaded = None
        gc.collect()
        try:
            self._loaded = await asyncio.to_thread(self._load, ref)
        except ModelNotFound:
            raise
        except Exception as exc:
            log.exception("transformers.load_failed", model=ref)
            raise ProviderError(f"Couldn't load {ref}: {type(exc).__name__}: {str(exc)[:200]}") from exc
        return self._loaded

    async def chat_stream(
        self, ref: str, messages: Sequence[ChatMessage], params: GenerationParams
    ) -> AsyncGenerator[StreamEvent]:
        if not ml_installed():
            raise ProviderUnavailable(INSTALL_HINT)
        async with self._lock:
            loaded = await self._ensure(ref)
            import torch
            from transformers import StoppingCriteria, StoppingCriteriaList, TextIteratorStreamer

            tok = loaded.tokenizer
            chat = [
                {"role": m.role, "content": m.content}
                for m in messages
                if m.role in ("system", "user", "assistant")
            ]
            if getattr(tok, "chat_template", None):
                prompt = tok.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)
            else:
                prompt = "\n".join(f"{m['role']}: {m['content']}" for m in chat) + "\nassistant:"
            inputs = tok(prompt, return_tensors="pt")
            prompt_tokens = int(inputs["input_ids"].shape[-1])
            if prompt_tokens + params.max_tokens > params.context_length:
                keep = max(params.context_length - params.max_tokens, 16)
                inputs = {k: v[:, -keep:] for k, v in inputs.items()}
                prompt_tokens = keep
            stop = threading.Event()

            class _Stop(StoppingCriteria):  # type: ignore[misc,unused-ignore]
                def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> bool:
                    return stop.is_set()

            streamer = TextIteratorStreamer(tok, skip_prompt=True, skip_special_tokens=True)
            gen_kwargs: dict[str, Any] = {
                **inputs,
                "max_new_tokens": params.max_tokens,
                "streamer": streamer,
                "stopping_criteria": StoppingCriteriaList([_Stop()]),
                "pad_token_id": tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id,
            }
            if params.temperature > 0:
                gen_kwargs.update(do_sample=True, temperature=params.temperature, top_p=params.top_p)
            else:
                gen_kwargs.update(do_sample=False)
            result: dict[str, Any] = {}

            def run() -> None:
                try:
                    if params.seed is not None:
                        torch.manual_seed(params.seed)
                    with torch.inference_mode():
                        out = loaded.model.generate(**gen_kwargs)
                    result["completion_tokens"] = int(out.shape[-1]) - prompt_tokens
                except Exception as exc:
                    result["error"] = exc
                    streamer.end()  # type: ignore[no-untyped-call,unused-ignore]

            worker = threading.Thread(target=run, name=f"hf-generate-{ref}", daemon=True)
            worker.start()
            iterator = iter(streamer)
            try:
                while True:
                    text = await asyncio.to_thread(next, iterator, None)
                    if text is None:
                        break
                    if text:
                        yield TokenDelta(text)
            finally:
                # Stop generating if the consumer went away (user pressed Stop).
                stop.set()
                await asyncio.to_thread(worker.join, 60)
            if "error" in result:
                raise ProviderError(f"Generation failed: {type(result['error']).__name__}: {result['error']}")
            completion = int(result.get("completion_tokens", 0))
            yield GenerationDone(
                finish_reason="length" if completion >= params.max_tokens else "stop",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion,
            )

    async def embed(self, ref: str, texts: Sequence[str]) -> list[list[float]]:
        raise ProviderError(
            "Embeddings from Transformers models aren't supported; use an Ollama embedding model."
        )

    async def aclose(self) -> None:
        self._loaded = None


def download_hf(repo_id: str, models_dir: Path) -> Path:
    """Download a Hugging Face repo snapshot: safetensors, config and tokenizer files only (no pickles).

    Internet access: callers must check the network gate first. Blocking; run in a thread."""
    from huggingface_hub import snapshot_download

    if not repo_id or repo_id.count("/") != 1 or ".." in repo_id or repo_id.startswith(("/", ".")):
        raise ValueError("Use a repository id like Qwen/Qwen2.5-0.5B-Instruct.")
    target = models_dir / repo_id.replace("/", "--")
    models_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=repo_id,
        local_dir=target,
        allow_patterns=[
            "*.json",
            "*.safetensors",
            "tokenizer*",
            "*.txt",
            "*.model",
            "*.tiktoken",
            "README.md",
            "LICENSE*",
        ],
    )
    return target
