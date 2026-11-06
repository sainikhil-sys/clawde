"""In-process ModelProvider for tests. It is a test double, not product functionality."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Sequence
from dataclasses import dataclass, field

from core.inference.provider import ModelNotFound, ProviderError, ProviderUnavailable
from core.inference.types import (
    ChatMessage,
    GenerationDone,
    GenerationParams,
    ProviderModel,
    StreamEvent,
    TokenDelta,
)


def fake_model(
    ref: str, *, capabilities: tuple[str, ...] = ("completion",), ctx: int = 8192
) -> ProviderModel:
    return ProviderModel(
        provider="fake",
        ref=ref,
        display_name=ref,
        family="test",
        parameter_size="1B",
        quantization="Q4",
        format="gguf",
        size_bytes=1000,
        context_length=ctx,
        capabilities=capabilities,
    )


@dataclass
class FakeProvider:
    name: str = "fake"
    models: list[ProviderModel] = field(
        default_factory=lambda: [fake_model("tiny"), fake_model("embedder", capabilities=("embedding",))]
    )
    reply: Sequence[str] = ("Hello", ", ", "world", "!")
    token_delay: float = 0.0
    fail_with: ProviderError | None = None
    fail_after_tokens: int | None = None
    available: bool = True
    # Observations for assertions
    received: list[list[ChatMessage]] = field(default_factory=list)
    received_params: list[GenerationParams] = field(default_factory=list)
    streams_closed: int = 0
    streams_completed: int = 0

    async def is_available(self) -> bool:
        return self.available

    async def list_models(self) -> list[ProviderModel]:
        if not self.available:
            raise ProviderUnavailable("fake provider is down")
        return list(self.models)

    async def chat_stream(
        self, ref: str, messages: Sequence[ChatMessage], params: GenerationParams
    ) -> AsyncGenerator[StreamEvent]:
        self.received.append(list(messages))
        self.received_params.append(params)
        try:
            if not self.available:
                raise ProviderUnavailable("fake provider is down")
            if ref not in {m.ref for m in self.models}:
                raise ModelNotFound(f"no model {ref}")
            if self.fail_with is not None and self.fail_after_tokens is None:
                raise self.fail_with
            for i, tok in enumerate(self.reply):
                if self.fail_with is not None and self.fail_after_tokens == i:
                    raise self.fail_with
                if self.token_delay:
                    await asyncio.sleep(self.token_delay)
                yield TokenDelta(tok)
            yield GenerationDone(finish_reason="stop", prompt_tokens=12, completion_tokens=len(self.reply))
            self.streams_completed += 1
        finally:
            self.streams_closed += 1

    async def aclose(self) -> None:
        return None
