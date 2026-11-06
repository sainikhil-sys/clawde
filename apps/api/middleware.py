"""Pure-ASGI middleware: request context/logging, body size limit, origin check, security headers."""

from __future__ import annotations

import json
import re
import time
import uuid
from collections.abc import Iterable

import structlog
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .security import UNSAFE_METHODS

log = structlog.get_logger("clawde.api")


async def _send_json_error(send: Send, status: int, code: str, message: str) -> None:
    body = json.dumps({"detail": {"code": code, "message": message}}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


class RequestContextMiddleware:
    """Assigns a request id, logs one structured line per request, adds security headers."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid.uuid4().hex[:16]
        structlog.contextvars.bind_contextvars(request_id=request_id)
        start = time.perf_counter()
        status_holder = {"status": 500}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
                headers["X-Content-Type-Options"] = "nosniff"
                headers["Referrer-Policy"] = "no-referrer"
                headers.setdefault("Cache-Control", "no-store")
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            log.exception("request.unhandled_error", method=scope["method"], path=scope["path"])
            raise
        finally:
            log.info(
                "request",
                method=scope["method"],
                path=scope["path"],
                status=status_holder["status"],
                duration_ms=round((time.perf_counter() - start) * 1000, 1),
            )
            structlog.contextvars.unbind_contextvars("request_id")


class BodySizeLimitMiddleware:
    """Rejects bodies over `max_bytes`, using Content-Length when present and counting otherwise."""

    def __init__(self, app: ASGIApp, max_bytes: int, path_limits: dict[str, int] | None = None) -> None:
        self.app = app
        self.default_max = max_bytes
        #: Path patterns (full-match regexes) with a larger allowance (file uploads); everything else uses the
        #: JSON limit.
        self.path_limits = [(re.compile(pattern), limit) for pattern, limit in (path_limits or {}).items()]

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        max_bytes = next((lim for rx, lim in self.path_limits if rx.fullmatch(path)), self.default_max)
        length = Headers(scope=scope).get("content-length")
        if length is not None:
            try:
                too_big = int(length) > max_bytes
            except ValueError:
                await _send_json_error(send, 400, "bad_content_length", "Invalid Content-Length header.")
                return
            if too_big:
                await _send_json_error(
                    send, 413, "body_too_large", f"Request body exceeds {max_bytes} bytes."
                )
                return

        received = 0
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > max_bytes:
                    raise _BodyTooLarge
            return message

        async def tracking_send(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge:
            if not response_started:
                await _send_json_error(
                    send, 413, "body_too_large", f"Request body exceeds {max_bytes} bytes."
                )


class _BodyTooLarge(Exception):
    pass


class OriginCheckMiddleware:
    """For state-changing requests from browsers, the Origin must be one of the allowed web UI origins.

    Requests without an Origin header (non-browser local tools) pass here but still need a valid
    session cookie and CSRF token at the route level.
    """

    def __init__(self, app: ASGIApp, allowed_origins: Iterable[str]) -> None:
        self.app = app
        self.allowed = frozenset(allowed_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] in UNSAFE_METHODS:
            origin = Headers(scope=scope).get("origin")
            if origin is not None and origin not in self.allowed:
                log.warning("request.origin_rejected", origin=origin, path=scope["path"])
                await _send_json_error(send, 403, "origin_not_allowed", "Request origin is not allowed.")
                return
        await self.app(scope, receive, send)
