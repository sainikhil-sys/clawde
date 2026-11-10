"""Reading local model files before importing them: GGUF headers and Hugging Face folders.

Only metadata is read (no weights are loaded). Paths are given by the user for files on this machine; only
`.gguf` files and folders with a `config.json` are accepted.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

GGUF_MAGIC = b"GGUF"
#: llama.cpp file types (general.file_type) for display.
FILE_TYPES = {
    0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S",
    12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K",
    30: "BF16",
}  # fmt: skip


class ModelFileError(ValueError):
    """The file isn't a usable model. The message is safe to show."""


@dataclass(slots=True)
class FileInfo:
    path: str
    format: str  # gguf | safetensors
    size_bytes: int
    name: str | None = None
    architecture: str | None = None
    parameter_count: int | None = None
    quantization: str | None = None
    context_length: int | None = None
    license: str | None = None
    details: dict[str, Any] = field(default_factory=dict)


def _field_value(reader: Any, key: str) -> Any:
    f = reader.fields.get(key)
    if f is None or not f.data:
        return None
    part = f.parts[f.data[0]]
    try:
        if f.types and f.types[0].name == "STRING":
            return bytes(part).decode("utf-8", errors="replace")
        value = part.tolist()
        return value[0] if isinstance(value, list) and len(value) == 1 else value
    except (AttributeError, IndexError, TypeError):
        return None


def read_gguf(path: Path) -> FileInfo:
    """Read a GGUF header (validated by magic bytes) with llama.cpp's `gguf` package."""
    if path.suffix.lower() != ".gguf":
        raise ModelFileError("Only .gguf files can be imported.")
    if not path.is_file():
        raise ModelFileError("File not found.")
    with path.open("rb") as fh:
        if fh.read(4) != GGUF_MAGIC:
            raise ModelFileError("This isn't a GGUF file (wrong header).")
    from gguf import GGUFReader  # local import: only needed here

    try:
        reader = GGUFReader(str(path), "r")
    except Exception as exc:  # the parser raises various errors on corrupt files
        raise ModelFileError(f"Couldn't read the GGUF header: {type(exc).__name__}") from exc
    arch = _field_value(reader, "general.architecture")

    def a(key: str) -> Any:
        return _field_value(reader, f"{arch}.{key}") if arch else None

    ft = _field_value(reader, "general.file_type")
    params = _field_value(reader, "general.parameter_count")
    return FileInfo(
        path=str(path),
        format="gguf",
        size_bytes=path.stat().st_size,
        name=_field_value(reader, "general.name"),
        architecture=arch,
        parameter_count=int(params) if isinstance(params, int | float) else None,
        quantization=FILE_TYPES.get(ft) if isinstance(ft, int) else None,
        context_length=a("context_length"),
        license=_field_value(reader, "general.license"),
        details={
            k: v
            for k, v in {
                "layers": a("block_count"),
                "embedding_length": a("embedding_length"),
                "head_count": a("attention.head_count"),
                "head_count_kv": a("attention.head_count_kv"),
            }.items()
            if isinstance(v, int)
        },
    )


def read_hf_folder(path: Path) -> FileInfo:
    """A Hugging Face model folder: config.json plus safetensors weights; licence from the model card."""
    cfg_path = path / "config.json"
    if not cfg_path.is_file():
        raise ModelFileError("Not a Hugging Face model folder (no config.json).")
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ModelFileError("config.json couldn't be read.") from exc
    weights = list(path.glob("*.safetensors"))
    if not weights:
        raise ModelFileError(
            "No .safetensors weights in this folder (other formats aren't loaded, for safety)."
        )
    archs = cfg.get("architectures") or []
    return FileInfo(
        path=str(path),
        format="safetensors",
        size_bytes=sum(w.stat().st_size for w in weights),
        name=path.name,
        architecture=str(archs[0]) if archs else cfg.get("model_type"),
        context_length=cfg.get("max_position_embeddings"),
        license=card_license(path),
        details={
            k: v
            for k, v in {
                "layers": cfg.get("num_hidden_layers"),
                "embedding_length": cfg.get("hidden_size"),
                "head_count": cfg.get("num_attention_heads"),
                "head_count_kv": cfg.get("num_key_value_heads"),
            }.items()
            if isinstance(v, int)
        },
    )


_LICENSE_LINE = re.compile(r"^license:\s*(.+)$", re.MULTILINE)


def card_license(folder: Path) -> str | None:
    """The `license:` field from a model card's YAML front matter."""
    readme = folder / "README.md"
    if not readme.is_file():
        return None
    text = readme.read_text(encoding="utf-8", errors="replace")[:20_000]
    if not text.startswith("---"):
        return None
    front = text.split("---", 2)[1] if text.count("---") >= 2 else ""
    m = _LICENSE_LINE.search(front)
    return m.group(1).strip().strip("'\"")[:200] if m else None
