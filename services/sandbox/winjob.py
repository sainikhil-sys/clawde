"""Windows Job Objects for the fallback Python sandbox: kill-on-close, a memory cap, one process only.

This only limits resources. It is NOT filesystem or network isolation; the fallback tier is labelled as
reduced isolation everywhere it is used.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from typing import Any

JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400
JobObjectExtendedLimitInformation = 9
PROCESS_SET_QUOTA = 0x0100
PROCESS_TERMINATE = 0x0001


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]  # fmt: skip


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
        ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def available() -> bool:
    return sys.platform == "win32"


class Job:
    """A job object; closing it kills every process inside."""

    def __init__(self, memory_bytes: int) -> None:
        if not available():
            raise OSError("Job objects are Windows-only")
        k32: Any = ctypes.WinDLL("kernel32", use_last_error=True)
        self._k32 = k32
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.OpenProcess.restype = wintypes.HANDLE
        self.handle = k32.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = (
            JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
        )
        info.BasicLimitInformation.ActiveProcessLimit = 1  # no child processes
        info.ProcessMemoryLimit = memory_bytes
        ok = k32.SetInformationJobObject(
            self.handle, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
        )
        if not ok:
            err = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(err)

    def assign(self, pid: int) -> None:
        proc = self._k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
        if not proc:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            if not self._k32.AssignProcessToJobObject(self.handle, proc):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            self._k32.CloseHandle(proc)

    def close(self) -> None:
        if self.handle:
            self._k32.CloseHandle(self.handle)
            self.handle = None
