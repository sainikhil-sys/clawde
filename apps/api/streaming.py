"""SSE response that always closes its body generator, so `finally` blocks run when a client disconnects.

Starlette cancels the streaming task on disconnect but leaves the async generator suspended; without an
explicit `aclose()` its cleanup (persisting a stopped reply, closing the model request) would only run
whenever the garbage collector gets to it.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable

import anyio
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from core.orchestrator.chat_turn import TurnEvent


async def encode_events(events: AsyncIterator[TurnEvent]) -> AsyncGenerator[bytes]:
    async for ev in events:
        yield ev.encode()


class EventStreamResponse(StreamingResponse):
    def __init__(
        self, events: AsyncGenerator[TurnEvent], on_close: Callable[[], Awaitable[None]] | None = None
    ) -> None:
        self._events = events
        self._on_close = on_close
        super().__init__(
            encode_events(events),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                body = self.body_iterator
                if isinstance(body, AsyncGenerator):
                    await body.aclose()
                await self._events.aclose()
                # Runs even if the client left before the first byte, when the generator body never started.
                if self._on_close is not None:
                    await self._on_close()
