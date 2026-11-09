"""Tool framework for agents: typed inputs (Pydantic -> JSON Schema), a risk level, and a registry.

Risk levels decide what permission policies are allowed (see core/permissions):
- ``read``: reads local data (files in the workspace, documents, memory, projects). Policy auto/ask/deny.
- ``compute``: pure computation with no access to anything (calculator, JSON). Policy auto/ask/deny.
- ``write``: changes files. Always asks (or is denied); can't be set to run automatically.
- ``execute``: runs code. Always asks (or is denied); can't be set to run automatically.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from core.inference.gateway import InferenceGateway

Risk = Literal["read", "compute", "write", "execute"]

#: Cap on what a tool result may put back into the model's context.
MAX_OUTPUT_CHARS = 12_000


class ToolError(Exception):
    """A tool failed in an expected way. The message is shown to the model and the user."""


@dataclass(slots=True)
class ToolContext:
    sessionmaker: async_sessionmaker[AsyncSession]
    gateway: InferenceGateway
    workspace: Path
    run_id: str
    project_id: str | None = None
    #: Extra services a tool may need (e.g. the Python sandbox), keyed by name.
    services: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ToolResult:
    output: str
    #: Structured details for the UI (not sent to the model).
    data: dict[str, Any] = field(default_factory=dict)
    #: Content came from files, documents or other data the user didn't write in this run: the model is told
    #: to treat it as data, not instructions.
    untrusted: bool = False


@dataclass(frozen=True, slots=True)
class Tool:
    name: str
    description: str
    risk: Risk
    args_model: type[BaseModel]
    run: Callable[[ToolContext, Any], Awaitable[ToolResult]]
    #: Some tools only make sense with a project scope (e.g. project search).
    needs_project: bool = False

    def schema(self) -> dict[str, Any]:
        schema = self.args_model.model_json_schema()
        schema.pop("title", None)
        return schema

    def parse_args(self, raw: Any) -> BaseModel:
        if not isinstance(raw, dict):
            raise ToolError(f"Arguments for {self.name} must be a JSON object.")
        try:
            return self.args_model.model_validate(raw)
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in e['loc']) or 'args'}: {e['msg']}" for e in exc.errors()[:5]
            )
            raise ToolError(f"Invalid arguments for {self.name}: {problems}") from exc


class ToolRegistry:
    def __init__(self, tools: list[Tool] | None = None) -> None:
        self._tools: dict[str, Tool] = {}
        for tool in tools or []:
            self.register(tool)

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"Tool {tool.name!r} is already registered.")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all(self) -> list[Tool]:
        return list(self._tools.values())


def clip(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated: {len(text) - limit:,} more characters]"
