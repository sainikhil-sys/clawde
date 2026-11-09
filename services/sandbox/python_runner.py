"""Run agent-written Python in a sandbox.

Tier 1, Docker: a throwaway container with no network, a read-only root filesystem, a small tmpfs, 512 MB of
memory, one CPU, a process limit, all capabilities dropped, no privilege escalation, and an unprivileged user.
The image must already be present locally (pulling it needs the network, which is off unless enabled).

Tier 2, fallback (no Docker): a separate Python process in an empty temporary folder, in isolated mode (-I),
with a minimal environment (none of the user's environment variables), a timeout and, on Windows, a Job
Object that caps memory, forbids child processes and kills everything when done. This tier does NOT isolate
the filesystem or the network, so it is labelled "reduced isolation" and every run needs the user's approval.

Blocking subprocess calls run in worker threads (the API's event loop on Windows may not support asyncio
subprocesses).
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Literal

import structlog

from . import winjob

log = structlog.get_logger("clawde.sandbox")

Tier = Literal["docker", "fallback"]
DEFAULT_IMAGE = "python:3.12-slim"
MAX_OUTPUT_BYTES = 64 * 1024
MAX_CODE_CHARS = 100_000

_BOOTSTRAP = (
    "import sys\n"
    "if sys.stdin.readline().strip() != 'go':\n"
    "    sys.exit(3)\n"
    "src = sys.stdin.read()\n"
    "exec(compile(src, '<agent>', 'exec'), {'__name__': '__main__'})\n"
)


@dataclass(slots=True)
class RunResult:
    tier: Tier
    stdout: str
    stderr: str
    exit_code: int | None
    timed_out: bool
    duration_ms: int
    truncated: bool


@dataclass(slots=True)
class SandboxStatus:
    #: ready | no_image | not_running | not_installed
    docker: str
    image: str
    #: Fallback is always possible; it's labelled reduced isolation.
    fallback_limits: str
    detail: str = ""

    @property
    def docker_ready(self) -> bool:
        return self.docker == "ready"


class _Collector(threading.Thread):
    """Reads a pipe to the end, keeping only the first `limit` bytes (so huge output can't exhaust memory)."""

    def __init__(self, stream: IO[bytes], limit: int) -> None:
        super().__init__(daemon=True)
        self.stream = stream
        self.limit = limit
        self.data = bytearray()
        self.truncated = False

    def run(self) -> None:
        while chunk := self.stream.read(8192):
            room = self.limit - len(self.data)
            if room > 0:
                self.data += chunk[:room]
            if len(chunk) > room:
                self.truncated = True


def base_interpreter() -> str:
    """The real Python interpreter, not a virtualenv launcher.

    On Windows a venv's python.exe (and uv's) is a small launcher that starts the base interpreter as a child
    process, which the Job Object's one-process limit (rightly) blocks. The base interpreter also means the
    sandboxed code sees only the standard library, not the app's own packages."""
    base = Path(getattr(sys, "_base_executable", "") or "")
    if base.is_file():
        return str(base)
    candidate = Path(sys.base_prefix) / ("python.exe" if sys.platform == "win32" else "bin/python3")
    return str(candidate) if candidate.is_file() else sys.executable


def _minimal_env(tmp: Path) -> dict[str, str]:
    env = {"PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1", "TEMP": str(tmp), "TMP": str(tmp)}
    for key in ("SYSTEMROOT", "WINDIR", "COMSPEC"):  # needed by the Windows runtime itself
        if key in os.environ:
            env[key] = os.environ[key]
    return env


class PythonSandbox:
    def __init__(
        self,
        tmp_root: Path,
        *,
        image: str = DEFAULT_IMAGE,
        timeout_s: float = 30.0,
        memory_mb: int = 512,
        docker_bin: str | None = None,
    ) -> None:
        self.tmp_root = tmp_root
        self.image = image
        self.timeout_s = timeout_s
        self.memory_mb = memory_mb
        self.docker_bin = docker_bin or shutil.which("docker")
        self._status: tuple[float, SandboxStatus] | None = None

    # ---- Docker detection ----

    def _docker(self, *args: str, timeout: float = 10.0) -> subprocess.CompletedProcess[str]:
        assert self.docker_bin
        return subprocess.run(  # noqa: S603 - fixed argv, no shell
            [self.docker_bin, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    def _probe(self) -> SandboxStatus:
        limits = (
            f"timeout {self.timeout_s:.0f}s, {self.memory_mb} MB memory, "
            "no child processes (Windows Job Object)"
            if winjob.available()
            else f"timeout {self.timeout_s:.0f}s"
        )
        if not self.docker_bin:
            return SandboxStatus("not_installed", self.image, limits, "Docker isn't installed.")
        try:
            info = self._docker("info", "--format", "{{.ServerVersion}}", timeout=8)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return SandboxStatus("not_running", self.image, limits, f"Docker didn't respond: {exc}")
        if info.returncode != 0:
            return SandboxStatus(
                "not_running", self.image, limits, "Docker is installed but its engine isn't running."
            )
        try:
            img = self._docker("image", "inspect", "--format", "{{.Id}}", self.image, timeout=8)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return SandboxStatus("not_running", self.image, limits, f"Docker didn't respond: {exc}")
        if img.returncode != 0:
            return SandboxStatus(
                "no_image",
                self.image,
                limits,
                f"The {self.image} image isn't downloaded yet (needs network access).",
            )
        return SandboxStatus("ready", self.image, limits, f"Docker {info.stdout.strip()}")

    async def status(self, *, refresh: bool = False) -> SandboxStatus:
        now = time.monotonic()
        if not refresh and self._status and now - self._status[0] < 30:
            return self._status[1]
        status = await asyncio.to_thread(self._probe)
        self._status = (now, status)
        return status

    async def prepare_docker(self) -> SandboxStatus:
        """Download the image. Callers must have checked that network access is enabled."""
        if not self.docker_bin:
            raise RuntimeError("Docker isn't installed.")
        result = await asyncio.to_thread(self._docker, "pull", self.image, timeout=900)
        if result.returncode != 0:
            raise RuntimeError(f"docker pull failed: {result.stderr.strip()[-500:]}")
        return await self.status(refresh=True)

    # ---- Running code ----

    async def run(self, code: str, *, tier: Tier) -> RunResult:
        if len(code) > MAX_CODE_CHARS:
            raise ValueError(f"Code is longer than {MAX_CODE_CHARS:,} characters.")
        if tier == "docker":
            return await asyncio.to_thread(self._run_docker, code)
        return await asyncio.to_thread(self._run_fallback, code)

    def _collect(
        self, proc: subprocess.Popen[bytes], on_timeout: object = None
    ) -> tuple[str, str, int | None, bool, bool]:
        assert proc.stdout and proc.stderr
        out, err = _Collector(proc.stdout, MAX_OUTPUT_BYTES), _Collector(proc.stderr, MAX_OUTPUT_BYTES)
        out.start()
        err.start()
        timed_out = False
        try:
            proc.wait(timeout=self.timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            if callable(on_timeout):
                on_timeout()
            proc.kill()
            proc.wait(timeout=10)
        out.join(timeout=5)
        err.join(timeout=5)
        return (
            out.data.decode("utf-8", "replace"),
            err.data.decode("utf-8", "replace"),
            None if timed_out else proc.returncode,
            timed_out,
            out.truncated or err.truncated,
        )

    def docker_args(self, name: str) -> list[str]:
        """The `docker run` command line: every isolation flag in one place (unit-tested)."""
        assert self.docker_bin
        return [
            self.docker_bin, "run", "--rm", "-i", "--name", name,
            "--network", "none",
            "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",  # noqa: S108 - container path
            "--memory", f"{self.memory_mb}m", "--memory-swap", f"{self.memory_mb}m",
            "--cpus", "1", "--pids-limit", "64",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", "65534:65534", "--workdir", "/tmp",  # noqa: S108 - container path
            "--env", "PYTHONDONTWRITEBYTECODE=1",
            self.image, "python", "-I", "-",
        ]  # fmt: skip

    def _run_docker(self, code: str) -> RunResult:
        name = f"clawde-py-{uuid.uuid4().hex[:12]}"
        args = self.docker_args(name)
        started = time.perf_counter()
        proc = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        assert proc.stdin
        try:
            proc.stdin.write(code.encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass

        def kill_container() -> None:
            try:
                self._docker("kill", name, timeout=15)
            except (OSError, subprocess.TimeoutExpired):
                log.warning("sandbox.docker_kill_failed", container=name)

        stdout, stderr, code_, timed_out, truncated = self._collect(proc, kill_container)
        return RunResult(
            "docker",
            stdout,
            stderr,
            code_,
            timed_out,
            round((time.perf_counter() - started) * 1000),
            truncated,
        )

    def _run_fallback(self, code: str) -> RunResult:
        self.tmp_root.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix="py-", dir=self.tmp_root))
        job: winjob.Job | None = None
        started = time.perf_counter()
        try:
            proc = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
                [base_interpreter(), "-I", "-c", _BOOTSTRAP],
                cwd=tmp,
                env=_minimal_env(tmp),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            assert proc.stdin
            if winjob.available():
                # The bootstrap waits for "go" so the limits apply before any agent code runs.
                job = winjob.Job(self.memory_mb * 1024 * 1024)
                try:
                    job.assign(proc.pid)
                except OSError:
                    proc.kill()
                    raise
            try:
                proc.stdin.write(b"go\n" + code.encode("utf-8"))
                proc.stdin.close()
            except OSError:
                pass
            stdout, stderr, code_, timed_out, truncated = self._collect(proc)
            return RunResult(
                "fallback",
                stdout,
                stderr,
                code_,
                timed_out,
                round((time.perf_counter() - started) * 1000),
                truncated,
            )
        finally:
            if job is not None:
                job.close()
            shutil.rmtree(tmp, ignore_errors=True)
