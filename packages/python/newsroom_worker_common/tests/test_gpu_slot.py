from __future__ import annotations

import multiprocessing
import os
import sys
import time
from pathlib import Path

import pytest

from newsroom_worker_common.gpu_slot import (
    DEFAULT_LOCK_ENV,
    DEFAULT_TIMEOUT_ENV,
    GpuSlot,
    GpuSlotTimeout,
    default_lock_path,
    default_timeout_seconds,
)


def _hold_slot(path: str, ready: multiprocessing.Event, release: multiprocessing.Event) -> None:
    slot = GpuSlot(path=path, timeout_seconds=5)
    slot.acquire()
    ready.set()
    release.wait(10)
    slot.release()


def test_slot_is_exclusive_across_processes(tmp_path: Path) -> None:
    lock_path = tmp_path / "gpu.lock"
    ready = multiprocessing.Event()
    release = multiprocessing.Event()
    worker = multiprocessing.Process(target=_hold_slot, args=(str(lock_path), ready, release))
    worker.start()
    try:
        assert ready.wait(5)
        holder = GpuSlot(path=lock_path, timeout_seconds=0.3, poll_interval_seconds=0.02)
        with pytest.raises(GpuSlotTimeout):
            holder.acquire()
        assert holder.acquired is False
    finally:
        release.set()
        worker.join(10)
        if worker.is_alive():  # pragma: no cover - defensive cleanup
            worker.terminate()
            worker.join(5)


def test_slot_releases_on_context_exit_and_can_be_reacquired(tmp_path: Path) -> None:
    lock_path = tmp_path / "gpu.lock"
    with GpuSlot(path=lock_path, owner="asr-worker", job_id="job-1", timeout_seconds=1) as slot:
        assert slot.acquired is True
        assert slot.holder_info()["owner"] == "asr-worker"
        assert slot.holder_info()["job_id"] == "job-1"
        assert str(os.getpid()) == slot.holder_info()["pid"]

    assert lock_path.read_text(encoding="utf-8") == ""
    with GpuSlot(path=lock_path, timeout_seconds=1) as second:
        assert second.acquired is True


def test_slot_timeout_zero_is_rejected_by_configuration() -> None:
    assert default_timeout_seconds({DEFAULT_TIMEOUT_ENV: "0"}) == 300.0
    assert default_timeout_seconds({DEFAULT_TIMEOUT_ENV: "1.5"}) == 1.5
    assert default_timeout_seconds({DEFAULT_TIMEOUT_ENV: "nope"}) == 300.0


def test_default_lock_path_honours_environment(tmp_path: Path) -> None:
    custom = tmp_path / "custom.lock"
    assert default_lock_path({DEFAULT_LOCK_ENV: str(custom)}) == custom
    assert default_lock_path({}) == Path(default_lock_path.__globals__["tempfile"].gettempdir()) / "newsroom-gpu.lock"


def test_holder_info_is_empty_for_unlocked_slot(tmp_path: Path) -> None:
    slot = GpuSlot(path=tmp_path / "gpu.lock", timeout_seconds=0.1)
    assert slot.holder_info() == {}
    assert slot.release() is False
