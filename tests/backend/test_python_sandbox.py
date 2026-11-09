"""The real Python sandbox: fallback limits on this machine, and the Docker isolation flags."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from services.sandbox.python_runner import PythonSandbox

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="Job Object limits are Windows-only")


@pytest.fixture
def sandbox(tmp_path: Path) -> PythonSandbox:
    return PythonSandbox(tmp_path, timeout_s=5, memory_mb=256)


async def test_fallback_runs_code_with_a_clean_environment(
    sandbox: PythonSandbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAWDE_FAKE_SECRET", "s3cret")
    r = await sandbox.run("import os; print(sum(range(10))); print(sorted(os.environ))", tier="fallback")
    assert r.exit_code == 0 and r.stdout.splitlines()[0] == "45"
    assert "CLAWDE_FAKE_SECRET" not in r.stdout and "s3cret" not in r.stdout
    # It ran in an empty temporary folder that is removed afterwards.
    assert list(sandbox.tmp_root.iterdir()) == []


@windows_only
async def test_fallback_limits_memory_and_child_processes(sandbox: PythonSandbox) -> None:
    mem = await sandbox.run("x = bytearray(600 * 1024 * 1024)\nprint('allocated')", tier="fallback")
    assert "allocated" not in mem.stdout and "MemoryError" in mem.stderr
    child = await sandbox.run(
        "import subprocess, sys\nsubprocess.run([sys.executable, '-c', 'print(1)'])\nprint('spawned')",
        tier="fallback",
    )
    assert "spawned" not in child.stdout and child.exit_code != 0


async def test_fallback_timeout_and_output_cap(sandbox: PythonSandbox) -> None:
    loop = await sandbox.run("while True: pass", tier="fallback")
    assert loop.timed_out and loop.exit_code is None and loop.duration_ms < 15_000
    big = await sandbox.run("print('x' * 1_000_000)", tier="fallback")
    assert big.truncated and len(big.stdout) <= 64 * 1024


def test_docker_isolation_flags(tmp_path: Path) -> None:
    sb = PythonSandbox(tmp_path, docker_bin="docker", memory_mb=512)
    args = sb.docker_args("clawde-py-test")
    joined = " ".join(args)
    for flag in [
        "--network none",
        "--read-only",
        "--memory 512m",
        "--memory-swap 512m",
        "--cpus 1",
        "--pids-limit 64",
        "--cap-drop ALL",
        "--security-opt no-new-privileges",
        "--user 65534:65534",
        "--rm",
    ]:
        assert flag in joined, flag
    # No host folders are mounted, and no environment from the host is passed through.
    assert "-v" not in args and "--volume" not in args and "--env-file" not in args
    assert args[-4:] == ["python:3.12-slim", "python", "-I", "-"]
    assert os.path.basename(args[0]) == "docker"
