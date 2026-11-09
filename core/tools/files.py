"""Workspace file tools. Every path is resolved inside the agent workspace (no absolute paths, no `..`, and
symlinks/junctions that lead outside are rejected by `safe_join`)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from storage.local_files.paths import UnsafePathError, safe_join

from .base import Tool, ToolContext, ToolError, ToolResult, clip

MAX_READ_CHARS = 20_000
MAX_WRITE_CHARS = 500_000
MAX_LIST = 200
#: Text formats the agent may read and write (no binaries, no executables).
TEXT_SUFFIXES = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".log",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".svg", ".xml", ".sql", ".sh", ".mmd", ".rst",
}  # fmt: skip


def _resolve(ctx: ToolContext, path: str) -> Path:
    ctx.workspace.mkdir(parents=True, exist_ok=True)
    try:
        return safe_join(ctx.workspace, path)
    except UnsafePathError as exc:
        raise ToolError(f"Path not allowed ({exc}). Use a relative path inside the workspace.") from exc


def _check_text(target: Path) -> None:
    if target.suffix.lower() not in TEXT_SUFFIXES:
        raise ToolError(
            f"Only text files can be read or written ({', '.join(sorted(TEXT_SUFFIXES))}); "
            f"got {target.suffix or 'no extension'}."
        )


class ReadArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(description="File path relative to the workspace, e.g. notes/todo.md")
    offset: int = Field(default=0, ge=0, description="Character offset to start reading from")


async def _read(ctx: ToolContext, args: ReadArgs) -> ToolResult:
    target = _resolve(ctx, args.path)
    _check_text(target)
    if not target.is_file():
        raise ToolError(f"No such file: {args.path}")
    text = await asyncio.to_thread(target.read_text, encoding="utf-8", errors="replace")
    chunk = text[args.offset : args.offset + MAX_READ_CHARS]
    more = len(text) - (args.offset + len(chunk))
    suffix = (
        f"\n… [{more:,} more characters; read again with offset={args.offset + len(chunk)}]"
        if more > 0
        else ""
    )
    return ToolResult(
        output=chunk + suffix,
        data={"path": args.path, "chars": len(text), "offset": args.offset},
        untrusted=True,
    )


class ListArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(default="", description="Folder relative to the workspace; empty for the top level")


async def _list(ctx: ToolContext, args: ListArgs) -> ToolResult:
    ctx.workspace.mkdir(parents=True, exist_ok=True)
    folder = ctx.workspace.resolve() if not args.path.strip() else _resolve(ctx, args.path)
    if not folder.is_dir():
        raise ToolError(f"No such folder: {args.path}")

    def scan() -> list[str]:
        out: list[str] = []
        for p in sorted(folder.rglob("*")):
            if len(out) >= MAX_LIST:
                out.append("… (more files not shown)")
                break
            if p.is_symlink():
                continue
            rel = p.relative_to(ctx.workspace.resolve()).as_posix()
            out.append(f"{rel}/" if p.is_dir() else f"{rel} ({p.stat().st_size:,} bytes)")
        return out

    entries = await asyncio.to_thread(scan)
    return ToolResult(output="\n".join(entries) or "(empty)", data={"count": len(entries)})


class WriteArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(description="File path relative to the workspace")
    content: str = Field(description="Text to write", max_length=MAX_WRITE_CHARS)
    mode: Literal["overwrite", "append"] = "overwrite"


async def _write(ctx: ToolContext, args: WriteArgs) -> ToolResult:
    target = _resolve(ctx, args.path)
    _check_text(target)

    def write() -> tuple[bool, int]:
        existed = target.exists()
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a" if args.mode == "append" else "w", encoding="utf-8") as fh:
            fh.write(args.content)
        return existed, target.stat().st_size

    existed, size = await asyncio.to_thread(write)
    verb = "Appended to" if args.mode == "append" else ("Overwrote" if existed else "Created")
    return ToolResult(
        output=f"{verb} {args.path} ({size:,} bytes).",
        data={"path": args.path, "bytes": size, "mode": args.mode, "existed": existed},
    )


READ_FILE = Tool(
    name="read_file",
    description="Read a text file from the workspace.",
    risk="read",
    args_model=ReadArgs,
    run=_read,
)
LIST_FILES = Tool(
    name="list_files",
    description="List files and folders in the workspace.",
    risk="read",
    args_model=ListArgs,
    run=_list,
)
WRITE_FILE = Tool(
    name="write_file",
    description="Create, overwrite or append to a text file in the workspace.",
    risk="write",
    args_model=WriteArgs,
    run=_write,
)

__all__ = ["LIST_FILES", "READ_FILE", "WRITE_FILE", "clip"]
