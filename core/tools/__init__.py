"""Agent tools. `default_registry()` returns the built-in set."""

from __future__ import annotations

from .base import Tool, ToolContext, ToolError, ToolRegistry, ToolResult


def default_registry() -> ToolRegistry:
    from .compute import CALCULATOR, JSON_TOOL
    from .files import LIST_FILES, READ_FILE, WRITE_FILE
    from .knowledge import SEARCH_DOCUMENTS, SEARCH_KNOWLEDGE, SEARCH_PROJECT
    from .python_tool import PYTHON

    return ToolRegistry(
        [
            READ_FILE,
            LIST_FILES,
            WRITE_FILE,
            SEARCH_DOCUMENTS,
            SEARCH_KNOWLEDGE,
            SEARCH_PROJECT,
            CALCULATOR,
            JSON_TOOL,
            PYTHON,
        ]
    )


__all__ = ["Tool", "ToolContext", "ToolError", "ToolRegistry", "ToolResult", "default_registry"]
