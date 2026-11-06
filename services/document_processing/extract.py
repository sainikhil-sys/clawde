"""Text extraction per file kind. Pure functions over a file path; run them off the event loop.

Limits keep a hostile or huge file from exhausting memory or CPU: page/row caps and a total character cap.
Extraction never executes anything: no macros, no formulas evaluated (cached values only), no scripts.
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .validation import UnsupportedFile, check_office_zip

MAX_CHARS = 2_000_000
MAX_PDF_PAGES = 500
MAX_SHEET_ROWS = 20_000
MAX_CSV_ROWS = 50_000
MAX_IMAGE_PIXELS = 50_000_000


@dataclass(slots=True)
class Extracted:
    text: str
    page_count: int | None = None
    meta: dict[str, Any] = field(default_factory=dict)


def _cap(text: str, meta: dict[str, Any]) -> str:
    if len(text) > MAX_CHARS:
        meta["truncated"] = True
        meta["original_chars"] = len(text)
        return text[:MAX_CHARS]
    return text


def decode_text(data: bytes, meta: dict[str, Any]) -> str:
    for enc in ("utf-8-sig", "utf-16"):
        if enc == "utf-16" and not data.startswith((b"\xff\xfe", b"\xfe\xff")):
            continue
        try:
            text = data.decode(enc)
            meta["encoding"] = "utf-8" if enc == "utf-8-sig" else enc
            return text
        except UnicodeDecodeError:
            continue
    # Last resort for legacy files: Windows-1252 decodes every byte; mark it so the UI can say so.
    meta["encoding"] = "cp1252 (guessed)"
    return data.decode("cp1252", errors="replace")


def extract_pdf(path: Path) -> Extracted:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    meta: dict[str, Any] = {}
    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            try:
                if not reader.decrypt(""):
                    raise UnsupportedFile("This PDF is password-protected.")
            except NotImplementedError as exc:
                raise UnsupportedFile("This PDF uses an unsupported encryption.") from exc
        total = len(reader.pages)
        parts: list[str] = []
        size = 0
        for i, page in enumerate(reader.pages):
            if i >= MAX_PDF_PAGES:
                meta["pages_truncated"] = True
                break
            page_text = (page.extract_text() or "").strip()
            parts.append(f"[Page {i + 1}]\n{page_text}" if page_text else f"[Page {i + 1}]")
            size += len(page_text)
            if size > MAX_CHARS:
                meta["truncated"] = True
                break
    except PdfReadError as exc:
        raise UnsupportedFile("This PDF is damaged or not readable.") from exc
    text = "\n\n".join(parts)
    if not any(line.strip() and not line.startswith("[Page ") for line in text.splitlines()):
        meta["no_text_layer"] = True  # likely a scan; OCR is not installed
    return Extracted(_cap(text, meta), page_count=total, meta=meta)


def extract_docx(path: Path) -> Extracted:
    import docx

    check_office_zip(path, "docx")
    meta: dict[str, Any] = {}
    document = docx.Document(str(path))
    lines: list[str] = []
    for para in document.paragraphs:
        style = (para.style.name or "").lower() if para.style is not None else ""
        txt = para.text.strip()
        if not txt:
            continue
        if style.startswith("heading"):
            level = "".join(ch for ch in style if ch.isdigit()) or "1"
            lines.append(f"{'#' * min(int(level), 6)} {txt}")
        elif "list" in style:
            lines.append(f"- {txt}")
        else:
            lines.append(txt)
    for t_index, table in enumerate(document.tables):
        lines.append(f"\n[Table {t_index + 1}]")
        for row in table.rows:
            lines.append(" | ".join(cell.text.strip() for cell in row.cells))
    meta["tables"] = len(document.tables)
    return Extracted(_cap("\n\n".join(lines), meta), meta=meta)


def extract_xlsx(path: Path) -> Extracted:
    from openpyxl import load_workbook

    check_office_zip(path, "xlsx")
    meta: dict[str, Any] = {"sheets": []}
    # read_only streams rows; data_only returns cached values instead of formulas (nothing is evaluated).
    wb = load_workbook(str(path), read_only=True, data_only=True)
    parts: list[str] = []
    try:
        for ws in wb.worksheets:
            rows: list[str] = []
            count = 0
            for row in ws.iter_rows(values_only=True):
                if count >= MAX_SHEET_ROWS:
                    meta.setdefault("rows_truncated", []).append(ws.title)
                    break
                cells = ["" if v is None else str(v) for v in row]
                while cells and cells[-1] == "":
                    cells.pop()
                if cells:
                    rows.append(" | ".join(cells))
                count += 1
            meta["sheets"].append({"name": ws.title, "rows": count})
            parts.append(f"[Sheet: {ws.title}]\n" + "\n".join(rows))
    finally:
        wb.close()
    return Extracted(_cap("\n\n".join(parts), meta), meta=meta)


def extract_csv(path: Path, delimiter: str | None = None) -> Extracted:
    meta: dict[str, Any] = {}
    text = decode_text(path.read_bytes(), meta)
    sample = text[:20_000]
    if delimiter is None:
        try:
            delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    meta["delimiter"] = delimiter
    out: list[str] = []
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    for i, row in enumerate(reader):
        if i >= MAX_CSV_ROWS:
            meta["rows_truncated"] = True
            break
        out.append(" | ".join(cell.strip() for cell in row))
    meta["rows"] = len(out)
    meta["columns"] = len(next(csv.reader(io.StringIO(sample), delimiter=delimiter), []))
    return Extracted(_cap("\n".join(out), meta), meta=meta)


def extract_json(path: Path) -> Extracted:
    meta: dict[str, Any] = {}
    raw = decode_text(path.read_bytes(), meta)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise UnsupportedFile(f"This JSON file isn't valid (line {exc.lineno}, column {exc.colno}).") from exc
    meta["top_level"] = type(data).__name__
    return Extracted(_cap(json.dumps(data, indent=2, ensure_ascii=False), meta), meta=meta)


def extract_text(path: Path) -> Extracted:
    meta: dict[str, Any] = {}
    text = decode_text(path.read_bytes(), meta)
    meta["lines"] = text.count("\n") + 1
    return Extracted(_cap(text, meta), meta=meta)


def extract_image(path: Path) -> Extracted:
    from PIL import Image, UnidentifiedImageError

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS  # decompression-bomb guard
    try:
        with Image.open(path) as img:
            img.verify()
        with Image.open(path) as img:
            meta = {"width": img.width, "height": img.height, "format": img.format, "mode": img.mode}
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        raise UnsupportedFile("This image is damaged or too large.") from exc
    # No OCR: the text is a description so models without vision know an image is there.
    return Extracted(f"[Image: {meta['width']}x{meta['height']} {meta['format']}]", meta=meta)


EXTRACTORS = {
    "pdf": extract_pdf,
    "docx": extract_docx,
    "xlsx": extract_xlsx,
    "csv": extract_csv,
    "json": extract_json,
    "markdown": extract_text,
    "text": extract_text,
    "code": extract_text,
    "image": extract_image,
}


def extract(kind: str, path: Path) -> Extracted:
    try:
        fn = EXTRACTORS[kind]
    except KeyError as exc:
        raise UnsupportedFile(f"No extractor for {kind}.") from exc
    return fn(path)
