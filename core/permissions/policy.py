"""Tool permission policies.

Each tool has a policy: ``auto`` (runs without asking), ``ask`` (pauses for the user's approval) or
``deny`` (never offered to the model and never run). Writing files and running code can only be ``ask`` or
``deny``: this safeguard can't be turned off from settings, and the agent has no way to change policies.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

from core.tools.base import Risk, Tool

Policy = Literal["auto", "ask", "deny"]

DEFAULT_POLICY: dict[Risk, Policy] = {"read": "auto", "compute": "auto", "write": "ask", "execute": "ask"}
ALLOWED: dict[Risk, frozenset[Policy]] = {
    "read": frozenset({"auto", "ask", "deny"}),
    "compute": frozenset({"auto", "ask", "deny"}),
    "write": frozenset({"ask", "deny"}),
    "execute": frozenset({"ask", "deny"}),
}


def allowed(tool: Tool) -> frozenset[Policy]:
    return ALLOWED[tool.risk]


def effective(tool: Tool, stored: Mapping[str, str]) -> Policy:
    """The policy in force: the stored choice if it's allowed for this tool's risk, else the default."""
    choice = stored.get(tool.name)
    if choice in ALLOWED[tool.risk]:
        return choice  # type: ignore[return-value,unused-ignore]  # narrowed by the membership test
    return DEFAULT_POLICY[tool.risk]
