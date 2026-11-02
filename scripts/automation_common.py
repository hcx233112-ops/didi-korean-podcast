"""Small shared primitives for the local automation (no network on import)."""
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_status(name, status, **details):
    atomic_json(ROOT / "logs" / f"{name}-status.log", {"status": status, "updated_at": utc_now(), **details})


class ProcessLock:
    """OS-released lock: Windows named mutex; flock on other platforms."""
    def __init__(self, path):
        self.path = Path(path)
        self.handle = None

    def acquire(self):
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
            kernel.CreateMutexW.restype = wintypes.HANDLE
            key = hashlib.sha256(str(self.path.resolve()).lower().encode()).hexdigest()
            handle = kernel.CreateMutexW(None, False, "Local\\DidiPodcast-" + key)
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            result = kernel.WaitForSingleObject(handle, 0)
            if result not in (0, 0x80):  # WAIT_OBJECT_0 / WAIT_ABANDONED
                kernel.CloseHandle.argtypes = [wintypes.HANDLE]
                kernel.CloseHandle(handle)
                if result == 0x102:
                    return False
                raise RuntimeError(f"Cannot acquire mutex: {result}")
            self.handle = handle
        else:
            import fcntl
            self.path.parent.mkdir(parents=True, exist_ok=True)
            stream = self.path.open("a+")
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                stream.close()
                return False
            self.handle = stream
        return True

    def release(self):
        if self.handle is None:
            return
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.ReleaseMutex(self.handle)
            kernel.CloseHandle(self.handle)
        else:
            self.handle.close()
        self.handle = None


def should_generate(path, force=False, now=None):
    """Success is permanent; negative results expire after seven days."""
    if force:
        return True
    data = read_json(path)
    if not isinstance(data, dict):
        return True
    if data.get("segments") and not data.get("error"):
        return False
    if data.get("error") != "no_transcript":
        return True
    try:
        checked = datetime.fromisoformat(data["checked_at"])
        if checked.tzinfo is None:
            return True
        return ((now or datetime.now(timezone.utc)) - checked).total_seconds() >= 7 * 86400
    except (KeyError, TypeError, ValueError):
        return True
