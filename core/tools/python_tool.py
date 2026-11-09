"""Sandboxed Python execution tool (always needs approval; see core/permissions)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from services.sandbox.python_runner import PythonSandbox, Tier

from .base import Tool, ToolContext, ToolError, ToolResult, clip


class PythonArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(
        description="A complete Python 3 program. Print the results you need.", max_length=100_000
    )


async def _run(ctx: ToolContext, args: PythonArgs) -> ToolResult:
    sandbox: PythonSandbox | None = ctx.services.get("python")
    if sandbox is None:
        raise ToolError("The Python sandbox isn't available.")
    status = await sandbox.status()
    tier: Tier = "docker" if status.docker_ready else "fallback"
    result = await sandbox.run(args.code, tier=tier)
    parts = []
    if result.stdout:
        parts.append(result.stdout.rstrip())
    if result.stderr:
        parts.append("[stderr]\n" + result.stderr.rstrip())
    if result.timed_out:
        parts.append(f"[stopped: the program ran longer than {sandbox.timeout_s:.0f} seconds]")
    elif result.exit_code not in (0, None):
        parts.append(f"[exit code {result.exit_code}]")
    if result.truncated:
        parts.append("[output truncated]")
    return ToolResult(
        output=clip("\n".join(parts) or "(no output)"),
        data={
            "tier": result.tier,
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
            "duration_ms": result.duration_ms,
            "reduced_isolation": result.tier == "fallback",
        },
    )


PYTHON = Tool(
    name="python",
    description=(
        "Run a short Python 3 program in a sandbox and see what it prints. It has no network access and no "
        "access to the workspace files; put any data it needs into the code. Standard library only."
    ),
    risk="execute",
    args_model=PythonArgs,
    run=_run,
)
