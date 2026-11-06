"""Decide what an uploaded file is, from its extension AND its content, before anything parses it.

The extension picks the expected kind; the file's leading bytes must agree (a renamed executable is rejected,
not "best-effort" parsed). Office files are zip containers and get zip-bomb checks before extraction.
"""

from __future__ import annotations

import re
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path

MAX_FILENAME_CHARS = 200

#: extension → (kind, mime type). Anything not listed is refused.
_EXTENSIONS: dict[str, tuple[str, str]] = {
    ".pdf": ("pdf", "application/pdf"),
    ".docx": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ".xlsx": ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ".csv": ("csv", "text/csv"),
    ".tsv": ("csv", "text/tab-separated-values"),
    ".json": ("json", "application/json"),
    ".md": ("markdown", "text/markdown"),
    ".markdown": ("markdown", "text/markdown"),
    ".txt": ("text", "text/plain"),
    ".log": ("text", "text/plain"),
    ".png": ("image", "image/png"),
    ".jpg": ("image", "image/jpeg"),
    ".jpeg": ("image", "image/jpeg"),
    ".gif": ("image", "image/gif"),
    ".webp": ("image", "image/webp"),
}
#: Source code and config files are read as UTF-8 text. They are never executed or rendered.
_CODE_EXTENSIONS = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cc",
    ".cs", ".go", ".rs", ".rb", ".php", ".swift", ".scala", ".sh", ".bash", ".ps1", ".sql", ".r", ".lua",
    ".dart", ".html", ".htm", ".css", ".scss", ".xml", ".svg", ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".env.example", ".dockerfile", ".gradle", ".vue", ".svelte", ".m", ".pl", ".hs", ".ex", ".exs",
}  # fmt: skip
for _ext in _CODE_EXTENSIONS:
    _EXTENSIONS.setdefault(_ext, ("code", "text/plain"))

#: Leading-byte signatures that mark executables and other binaries we never accept, whatever the name.
#: Windows PE, Linux ELF and macOS Mach-O. Shell scripts ("#!") are fine: they are read as code text.
_FORBIDDEN_SIGNATURES = (b"MZ", b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xce", b"\xca\xfe\xba\xbe")

# Zip-bomb limits for DOCX/XLSX.
MAX_ZIP_UNCOMPRESSED = 200 * 1024 * 1024
MAX_ZIP_RATIO = 100
MAX_ZIP_ENTRIES = 5000


class UnsupportedFile(ValueError):
    """The file is not accepted. The message is safe to show to the user."""


@dataclass(frozen=True, slots=True)
class FileType:
    kind: str
    mime_type: str
    extension: str


def sanitize_filename(name: str) -> str:
    """Display name only: last path component, no control characters, bounded length."""
    base = re.split(r"[\\/]", name or "")[-1]
    base = unicodedata.normalize("NFC", base)
    base = "".join(ch for ch in base if unicodedata.category(ch)[0] != "C").strip().strip(".")
    if not base:
        base = "file"
    if len(base) > MAX_FILENAME_CHARS:
        stem, dot, ext = base.rpartition(".")
        base = (
            (stem[: MAX_FILENAME_CHARS - len(ext) - 1] + dot + ext)
            if dot and len(ext) <= 10
            else base[:MAX_FILENAME_CHARS]
        )
    return base


def _extension(name: str) -> str:
    lower = name.lower()
    if lower.endswith(".env.example"):
        return ".env.example"
    if lower == "dockerfile":
        return ".dockerfile"
    return Path(lower).suffix


def detect(filename: str, head: bytes) -> FileType:
    """Validate type from extension + content. `head` is the first few KB of the file."""
    ext = _extension(filename)
    entry = _EXTENSIONS.get(ext)
    if entry is None:
        raise UnsupportedFile(f"Files of type '{ext or 'unknown'}' aren't supported.")
    kind, mime = entry
    if not head:
        raise UnsupportedFile("The file is empty.")
    if head.startswith(_FORBIDDEN_SIGNATURES):
        raise UnsupportedFile("This file looks like a program, not a document.")

    if kind == "pdf" and not head.startswith(b"%PDF-"):
        raise UnsupportedFile("This doesn't look like a valid PDF.")
    if kind in ("docx", "xlsx") and not head.startswith(b"PK\x03\x04"):
        raise UnsupportedFile(f"This doesn't look like a valid {kind.upper()} file.")
    if kind == "image":
        signatures = {
            "image/png": (b"\x89PNG\r\n\x1a\n",),
            "image/jpeg": (b"\xff\xd8\xff",),
            "image/gif": (b"GIF87a", b"GIF89a"),
            "image/webp": (b"RIFF",),
        }[mime]
        if not head.startswith(signatures) or (mime == "image/webp" and head[8:12] != b"WEBP"):
            raise UnsupportedFile("The image content doesn't match its file type.")
    is_text = kind in ("csv", "json", "markdown", "text", "code")
    if is_text and b"\x00" in head and not head.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise UnsupportedFile("This file contains binary data, not text.")
    return FileType(kind=kind, mime_type=mime, extension=ext)


def check_office_zip(path: Path, kind: str) -> None:
    """Refuse corrupt, oversized or zip-bomb Office files before a parser opens them."""
    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            if len(infos) > MAX_ZIP_ENTRIES:
                raise UnsupportedFile("The file has too many internal parts.")
            total = sum(i.file_size for i in infos)
            compressed = max(1, sum(i.compress_size for i in infos))
            if total > MAX_ZIP_UNCOMPRESSED or total / compressed > MAX_ZIP_RATIO:
                raise UnsupportedFile("The file expands to an unsafe size when opened.")
            names = {i.filename for i in infos}
            required = "word/document.xml" if kind == "docx" else "xl/workbook.xml"
            if "[Content_Types].xml" not in names or required not in names:
                raise UnsupportedFile(f"This doesn't look like a valid {kind.upper()} file.")
    except zipfile.BadZipFile as exc:
        raise UnsupportedFile(f"This {kind.upper()} file is damaged.") from exc
