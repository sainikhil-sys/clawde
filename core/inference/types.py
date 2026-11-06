"""Provider-independent inference types. Nothing here knows about Ollama, llama.cpp or Transformers."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True, slots=True)
class ChatMessage:
    role: Role
    content: str
    #: Raw image bytes for vision-capable models (empty for text-only messages).
    images: tuple[bytes, ...] = ()


class GenerationParams(BaseModel):
    """Sampling and length controls. Adapters map these onto their backend's option names."""

    model_config = ConfigDict(extra="forbid")

    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float = Field(default=0.9, gt=0.0, le=1.0)
    max_tokens: int = Field(default=1024, ge=1, le=32_768)
    #: Context window to allocate. Larger values use more RAM (KV cache).
    context_length: int = Field(default=4096, ge=512, le=131_072)
    seed: int | None = Field(default=None, ge=0)
    #: "json" constrains output to valid JSON (structured output / JSON mode) on backends that support it.
    response_format: Literal["text", "json"] = "text"


@dataclass(frozen=True, slots=True)
class TokenDelta:
    text: str


@dataclass(frozen=True, slots=True)
class GenerationDone:
    finish_reason: str  # "stop" | "length" | backend-specific
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_duration_ms: float | None = None
    load_duration_ms: float | None = None


StreamEvent = TokenDelta | GenerationDone


@dataclass(frozen=True, slots=True)
class ProviderModel:
    """A model as reported by a provider. `ref` is the provider's own identifier."""

    provider: str
    ref: str
    display_name: str
    family: str | None = None
    parameter_size: str | None = None
    quantization: str | None = None
    format: str | None = None
    size_bytes: int | None = None
    context_length: int | None = None
    digest: str | None = None
    modified_at: datetime | None = None
    capabilities: tuple[str, ...] = field(default_factory=tuple)

    @property
    def model_id(self) -> str:
        return make_model_id(self.provider, self.ref)


def make_model_id(provider: str, ref: str) -> str:
    return f"{provider}:{ref}"


def split_model_id(model_id: str) -> tuple[str, str]:
    provider, sep, ref = model_id.partition(":")
    if not sep or not provider or not ref:
        raise ValueError(f"invalid model id {model_id!r}; expected '<provider>:<ref>'")
    return provider, ref
