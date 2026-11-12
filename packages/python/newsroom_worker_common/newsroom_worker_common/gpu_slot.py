from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

DEFAULT_LOCK_ENV = "NEWSROOM_GPU_LOCK_PATH"
DEFAULT_TIMEOUT_ENV = "NEWSROOM_GPU_LOCK_TIMEOUT_SECONDS"
DEFAULT_LOCK_NAME = "newsroom-gpu.lock"

if sys.platform == "win32":  # pragma: no cover - exercised on Windows only
    import msvcrt
else:
    import fcntl


class GpuSlotTimeout(RuntimeError):
    """Raised when the single GPU slot is busy for longer than the timeout."""

    def __init__(self, lock_path: Path, timeout_seconds: float):
        self.lock_path = lock_path
        self.timeout_seconds = timeout_seconds
        super().__init__(
            f"GPU slot busy: could not acquire {lock_path} within {timeout_seconds:g}s"
        )


def default_lock_path(env: dict[str, str] | os._Environ[str] | None = None) -> Path:
    values = os.environ if env is None else env
    configured = str(values.get(DEFAULT_LOCK_ENV, "") or "").strip()
    if configured:
        return Path(configured)
    return Path(tempfile.gettempdir()) / DEFAULT_LOCK_NAME


def default_timeout_seconds(env: dict[str, str] | os._Environ[str] | None = None) -> float:
    values = os.environ if env is None else env
    raw = str(values.get(DEFAULT_TIMEOUT_ENV, "") or "").strip()
    if not raw:
        return 300.0
    try:
        value = float(raw)
    except ValueError:
        return 300.0
    return value if value > 0 else 300.0


class GpuSlot:
    """Blocking exclusive lock shared by every GPU worker process.

    Usage::

        with GpuSlot(owner="asr-worker", job_id=job_id):
            model.transcribe(audio)

    The lock file is created if missing. On Unix `flock` is released by the
    kernel if the process dies; on Windows the `msvcrt.locking` byte lock gives
    the same guarantee for a crashed holder.
    """

    def __init__(
        self,
        *,
        path: str | Path | None = None,
        timeout_seconds: float | None = None,
        poll_interval_seconds: float = 0.1,
        owner: str = "",
        job_id: str = "",
        env: dict[str, str] | os._Environ[str] | None = None,
    ):
        self.path = Path(path) if path is not None else default_lock_path(env)
        self.timeout_seconds = (
            float(timeout_seconds)
            if timeout_seconds is not None
            else default_timeout_seconds(env)
        )
        self.poll_interval_seconds = max(0.01, float(poll_interval_seconds))
        self.owner = owner
        self.job_id = job_id
        self._file: Any | None = None
        self._acquired = False

    @property
    def acquired(self) -> bool:
        return self._acquired

    def acquire(self) -> "GpuSlot":
        if self._acquired:
            return self
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self.path, "a+", encoding="utf-8")
        deadline = time.monotonic() + self.timeout_seconds
        try:
            while True:
                if self._try_lock(handle):
                    break
                if time.monotonic() >= deadline:
                    raise GpuSlotTimeout(self.path, self.timeout_seconds)
                time.sleep(self.poll_interval_seconds)
        except BaseException:
            handle.close()
            raise

        self._file = handle
        self._acquired = True
        self._write_holder()
        return self

    def release(self) -> bool:
        if not self._acquired or self._file is None:
            return False
        handle = self._file
        try:
            self._truncate_holder()
        finally:
            try:
                self._unlock(handle)
            finally:
                handle.close()
                self._file = None
                self._acquired = False
        return True

    def __enter__(self) -> "GpuSlot":
        return self.acquire()

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.release()

    def holder_info(self) -> dict[str, str]:
        try:
            payload = self.path.read_text(encoding="utf-8").strip()
        except OSError:
            return {}
        if not payload:
            return {}
        return {
            "raw": payload,
            "pid": _extract_field(payload, "pid"),
            "owner": _extract_field(payload, "owner"),
            "job_id": _extract_field(payload, "job_id"),
        }

    def _write_holder(self) -> None:
        if self._file is None:
            return
        payload = f"pid={os.getpid()} owner={self.owner or '-'} job_id={self.job_id or '-'}"
        self._file.seek(0)
        self._file.truncate()
        self._file.write(payload)
        self._file.flush()

    def _truncate_holder(self) -> None:
        if self._file is None:
            return
        self._file.seek(0)
        self._file.truncate()
        self._file.flush()

    @staticmethod
    def _try_lock(handle: Any) -> bool:
        try:
            if sys.platform == "win32":  # pragma: no cover - Windows only
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    @staticmethod
    def _unlock(handle: Any) -> None:
        try:
            if sys.platform == "win32":  # pragma: no cover - Windows only
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass


def _extract_field(payload: str, key: str) -> str:
    for token in payload.split():
        if token.startswith(f"{key}="):
            return token[len(key) + 1 :]
    return ""
