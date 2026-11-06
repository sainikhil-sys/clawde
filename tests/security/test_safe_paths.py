from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from storage.local_files.paths import UnsafePathError, safe_join


@pytest.fixture
def root(tmp_path: Path) -> Path:
    r = tmp_path / "workspace"
    (r / "docs").mkdir(parents=True)
    return r


@pytest.mark.parametrize(
    "path",
    ["notes.txt", "docs/a.md", "docs\\b.md", "./docs/./c.md", "new/folder/file.json", "naïve ünïcode.txt"],
)
def test_allows_paths_inside_root(root: Path, path: str) -> None:
    result = safe_join(root, path)
    assert result.is_relative_to(root.resolve())


@pytest.mark.parametrize(
    "path",
    [
        "",
        "   ",
        ".",
        "..",
        "../secret.txt",
        "docs/../../secret.txt",
        "docs\\..\\..\\secret.txt",
        "/etc/passwd",
        "\\Windows\\win.ini",
        "C:\\Windows\\win.ini",
        "c:relative.txt",
        "\\\\server\\share\\file",
        "//server/share/file",
        "file\x00.txt",
        "file\n.txt",
        "CON",
        "nul.txt",
        "docs/COM1.log",
        "LPT9",
        "report.txt.",
        "report.txt ",
        "data.txt:hidden",
        'quote".txt',
        "a" * 256,
        "a/" * 600,
    ],
)
def test_rejects_unsafe_paths(root: Path, path: str) -> None:
    with pytest.raises(UnsafePathError):
        safe_join(root, path)


def test_rejects_symlink_escape(root: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    link = root / "link"
    try:
        os.symlink(outside, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        if sys.platform != "win32":
            raise
        # Windows needs Developer Mode or admin for symlinks; a directory junction is the common equivalent.
        import _winapi

        _winapi.CreateJunction(str(outside), str(link))
    with pytest.raises(UnsafePathError):
        safe_join(root, "link/secret.txt")


def test_root_must_exist(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        safe_join(tmp_path / "missing", "a.txt")
