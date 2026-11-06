"""The contract every model backend implements. App code depends only on this protocol."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Sequence
from typing import Protocol, runtime_checkable

from .types import ChatMessage, GenerationParams, ProviderModel, StreamEvent


class ProviderError(Exception):
    """Base class. `code` is a stable machine-readable identifier sent to clients."""

    code = "provider_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class ProviderUnavailable(ProviderError):
    code = "provider_unavailable"


class ModelNotFound(ProviderError):
    code = "model_not_found"


@runtime_checkable
class ModelProvider(Protocol):
    #: Short stable name used as the model id prefix, e.g. "ollama".
    name: str

    async def is_available(self) -> bool:
        """Cheap reachability check. Never raises."""
        ...

    async def list_models(self) -> list[ProviderModel]:
        """Models installed locally. Raises ProviderUnavailable if the backend cannot be reached."""
        ...

    def chat_stream(
        self, ref: str, messages: Sequence[ChatMessage], params: GenerationParams
    ) -> AsyncGenerator[StreamEvent]:
        """Yield TokenDelta events, then exactly one GenerationDone.

        Closing the iterator early (client stopped) must abort the backend request so it stops generating.
        """
        ...

    async def aclose(self) -> None: ...
