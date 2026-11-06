"""Routes model ids to the provider that serves them."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Iterable, Sequence

from .provider import ModelNotFound, ModelProvider
from .types import ChatMessage, GenerationParams, StreamEvent, split_model_id


class InferenceGateway:
    def __init__(self, providers: Iterable[ModelProvider]) -> None:
        self._providers: dict[str, ModelProvider] = {}
        for p in providers:
            if p.name in self._providers:
                raise ValueError(f"duplicate provider name {p.name!r}")
            self._providers[p.name] = p

    @property
    def providers(self) -> dict[str, ModelProvider]:
        return dict(self._providers)

    def provider_for(self, model_id: str) -> tuple[ModelProvider, str]:
        name, ref = split_model_id(model_id)
        provider = self._providers.get(name)
        if provider is None:
            raise ModelNotFound(f"No provider named {name!r} is configured.")
        return provider, ref

    def chat_stream(
        self, model_id: str, messages: Sequence[ChatMessage], params: GenerationParams
    ) -> AsyncGenerator[StreamEvent]:
        provider, ref = self.provider_for(model_id)
        return provider.chat_stream(ref, messages, params)

    async def aclose(self) -> None:
        for p in self._providers.values():
            await p.aclose()
