"""Path-traversal-safe resolution of user- or model-supplied relative paths inside a root folder.

Every file access driven by user input, uploads or agent tools must go through `safe_join`.
"""

from __future__ import annotations

import re
from pathlib import Path

MAX_PATH_CHARS = 1024
MAX_COMPONENT_CHARS = 255

# Device names Windows treats specially in any folder, with or without an extension.
_WINDOWS_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
    | {"COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"}
)
_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
# Control characters and characters Windows forbids in names. ':' also blocks NTFS alternate data streams.
_FORBIDDEN_CHARS = re.compile(r'[\x00-\x1f<>:"|?*]')


class UnsafePathError(ValueError):
    """Raised when a path could escape its root or is not portable/safe."""


def _validate_component(part: str) -> None:
    if part == "..":
        raise UnsafePathError("parent directory references ('..') are not allowed")
    if len(part) > MAX_COMPONENT_CHARS:
        raise UnsafePathError("path component is too long")
    if _FORBIDDEN_CHARS.search(part):
        raise UnsafePathError(f"path component contains forbidden characters: {part!r}")
    if part != part.rstrip(" ."):
        # Windows silently strips trailing dots/spaces, which lets 'a.txt.' alias 'a.txt'.
        raise UnsafePathError(f"path component ends with a dot or space: {part!r}")
    stem = part.split(".", 1)[0].upper()
    if stem in _WINDOWS_RESERVED:
        raise UnsafePathError(f"reserved device name: {part!r}")


def safe_join(root: Path, user_path: str) -> Path:
    """Resolve `user_path` (relative, '/' or '\\' separated) under `root`.

    Rejects absolute paths, drive letters, UNC paths, '..', NUL/control characters, reserved device
    names and anything that resolves outside `root` after following symlinks and junctions.
    The returned path may not exist yet. `root` must exist.
    """
    if not isinstance(user_path, str) or not user_path.strip():
        raise UnsafePathError("path is empty")
    if len(user_path) > MAX_PATH_CHARS:
        raise UnsafePathError("path is too long")

    normalized = user_path.replace("\\", "/")
    if normalized.startswith("/") or _DRIVE_PREFIX.match(normalized):
        raise UnsafePathError("absolute paths are not allowed")

    parts = [p for p in normalized.split("/") if p not in ("", ".")]
    if not parts:
        raise UnsafePathError("path does not name a file or folder")
    for part in parts:
        _validate_component(part)

    root_resolved = root.resolve(strict=True)
    candidate = root_resolved.joinpath(*parts).resolve(strict=False)
    if candidate == root_resolved or not candidate.is_relative_to(root_resolved):
        raise UnsafePathError("path resolves outside the allowed folder")
    return candidate
