"""Hardware snapshot (RAM, CPU, GPU) and model memory estimates.

RAM and CPU come from psutil. GPU utilisation on Windows comes from the "GPU Engine" performance counters
(the same numbers Task Manager shows); this works for integrated GPUs too but gives no separate VRAM figure.
Where a number can't be measured it is reported as unknown, never guessed.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any, Literal

import psutil
import structlog

log = structlog.get_logger("clawde.hardware")

Fit = Literal["fits", "tight", "wont_fit", "unknown"]
GB = 1024**3


@dataclass(frozen=True, slots=True)
class Snapshot:
    ram_total: int
    ram_available: int
    ram_used_percent: float
    cpu_percent: float
    cpu_count: int
    gpu_percent: float | None
    gpu_note: str


_gpu_cache: tuple[float, float | None, str] | None = None

_GPU_SCRIPT = (
    "$s = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction Stop).CounterSamples;"
    "($s | Measure-Object -Property CookedValue -Sum).Sum"
)


def _gpu_percent() -> tuple[float | None, str]:
    if sys.platform != "win32":
        return None, "GPU use isn't measured on this platform."
    try:
        out = subprocess.run(  # noqa: S603 - fixed command, no user input
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", _GPU_SCRIPT],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        value = float(out.stdout.strip().replace(",", "."))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None, "GPU counters aren't available."
    return round(min(value, 100.0), 1), "3D engine utilisation (Windows performance counters)"


async def snapshot() -> Snapshot:
    global _gpu_cache
    vm = psutil.virtual_memory()
    cpu = await asyncio.to_thread(psutil.cpu_percent, 0.3)
    now = time.monotonic()
    if _gpu_cache is None or now - _gpu_cache[0] > 10:
        gpu, note = await asyncio.to_thread(_gpu_percent)
        _gpu_cache = (now, gpu, note)
    return Snapshot(
        ram_total=vm.total,
        ram_available=vm.available,
        ram_used_percent=vm.percent,
        cpu_percent=cpu,
        cpu_count=psutil.cpu_count() or 1,
        gpu_percent=_gpu_cache[1],
        gpu_note=_gpu_cache[2],
    )


def kv_cache_bytes(details: dict[str, Any], context_length: int) -> int | None:
    """f16 K and V for every layer: 2 * layers * context * (embedding * kv_heads / heads) * 2 bytes."""
    values = [details.get(k) for k in ("layers", "embedding_length", "head_count")]
    values.append(details.get("head_count_kv") or values[2])
    if not all(isinstance(v, int) and v > 0 for v in values):
        return None
    layers, emb, heads, kv_heads = (int(v) for v in values)  # type: ignore[arg-type]
    kv_dim = emb * kv_heads // heads
    return 2 * layers * context_length * kv_dim * 2


def estimate_ram(size_bytes: int | None, details: dict[str, Any], context_length: int) -> int | None:
    """Weights (file size + 10% runtime overhead) plus the KV cache for `context_length` tokens.

    Without layer shapes, the KV cache is approximated as 12% of the weights per 4k tokens (typical for
    grouped-query-attention models), which is labelled as an approximation in the UI."""
    if not size_bytes:
        return None
    kv = kv_cache_bytes(details, context_length)
    if kv is None:
        kv = int(size_bytes * 0.12 * context_length / 4096)
    return int(size_bytes * 1.1) + kv


def fit(estimate: int | None, available: int, *, already_loaded: int = 0) -> Fit:
    """Compare an estimate with free RAM (memory the model already holds counts as free for it)."""
    if not estimate:
        return "unknown"
    room = available + already_loaded
    if estimate <= room * 0.8:
        return "fits"
    if estimate <= room:
        return "tight"
    return "wont_fit"


def as_json(s: Snapshot) -> dict[str, Any]:
    return {
        "ram_total": s.ram_total,
        "ram_available": s.ram_available,
        "ram_used_percent": s.ram_used_percent,
        "cpu_percent": s.cpu_percent,
        "cpu_count": s.cpu_count,
        "gpu_percent": s.gpu_percent,
        "gpu_note": s.gpu_note,
    }
