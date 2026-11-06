"""Persistent cosine-similarity index over embedding vectors, one per scope (e.g. one per project).

Files: `<dir>/<scope>.faiss` (FAISS IndexIDMap over IndexFlatIP with L2-normalised vectors) and
`<scope>.json` (embedding model, dimension, and a signature of the chunks it was built from).
The database stays the source of truth: if the signature doesn't match, callers rebuild.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

import faiss
import numpy as np

_SCOPE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,80}$")


@dataclass(frozen=True, slots=True)
class IndexMeta:
    model: str
    dim: int
    signature: str
    count: int


class VectorIndex:
    def __init__(self, directory: Path, scope: str) -> None:
        if not _SCOPE.match(scope):
            raise ValueError(f"invalid index scope {scope!r}")
        self.directory = directory
        self.scope = scope
        self._index: faiss.Index | None = None
        self._meta: IndexMeta | None = None

    @property
    def index_path(self) -> Path:
        return self.directory / f"{self.scope}.faiss"

    @property
    def meta_path(self) -> Path:
        return self.directory / f"{self.scope}.json"

    def load(self) -> IndexMeta | None:
        if self._meta is not None:
            return self._meta
        if not (self.index_path.is_file() and self.meta_path.is_file()):
            return None
        try:
            meta = IndexMeta(**json.loads(self.meta_path.read_text(encoding="utf-8")))
            self._index = faiss.read_index(str(self.index_path))
        except (ValueError, TypeError, RuntimeError, OSError):
            return None  # corrupt or from another version: caller rebuilds
        self._meta = meta
        return meta

    def build(
        self, ids: Sequence[int], vectors: Sequence[Sequence[float]], *, model: str, signature: str
    ) -> IndexMeta:
        if len(ids) != len(vectors):
            raise ValueError("ids and vectors differ in length")
        dim = len(vectors[0]) if vectors else 0
        index = faiss.IndexIDMap2(faiss.IndexFlatIP(max(dim, 1)))
        if vectors:
            mat = np.asarray(vectors, dtype="float32")
            if mat.ndim != 2 or mat.shape[1] != dim:
                raise ValueError("all vectors must have the same dimension")
            faiss.normalize_L2(mat)
            index.add_with_ids(mat, np.asarray(ids, dtype="int64"))
        meta = IndexMeta(model=model, dim=dim, signature=signature, count=len(ids))
        self.directory.mkdir(parents=True, exist_ok=True)
        # Write to temporary names first so a crash never leaves a half-written index in place.
        tmp_index = self.index_path.with_suffix(".faiss.tmp")
        tmp_meta = self.meta_path.with_suffix(".json.tmp")
        faiss.write_index(index, str(tmp_index))
        tmp_meta.write_text(json.dumps(asdict(meta)), encoding="utf-8")
        os.replace(tmp_index, self.index_path)
        os.replace(tmp_meta, self.meta_path)
        self._index, self._meta = index, meta
        return meta

    def search(self, vector: Sequence[float], k: int) -> list[tuple[int, float]]:
        """(id, cosine similarity) pairs, best first."""
        meta = self.load()
        if meta is None or self._index is None or meta.count == 0:
            return []
        if len(vector) != meta.dim:
            raise ValueError(f"query has dimension {len(vector)}, index has {meta.dim}")
        q = np.asarray([vector], dtype="float32")
        faiss.normalize_L2(q)
        scores, ids = self._index.search(q, min(k, meta.count))
        return [(int(i), float(s)) for i, s in zip(ids[0], scores[0], strict=True) if i != -1]

    def delete(self) -> None:
        for path in (self.index_path, self.meta_path):
            path.unlink(missing_ok=True)
        self._index, self._meta = None, None
