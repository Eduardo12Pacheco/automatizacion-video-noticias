from __future__ import annotations

import asyncio
import logging
import threading
import time

from app.runtime import RuntimeCoordinator, RuntimeLoop
from app.main import _build_runtime_coordinator
from app.settings import Settings
from app.store import MonitorStore


class FakeDuty:
    def __init__(self, *, fail_once: bool = False):
        self.calls = 0
        self.fail_once = fail_once

    async def __call__(self):
        self.calls += 1
        if self.fail_once and self.calls == 1:
            raise RuntimeError("boom")


class BlockingSleep:
    def __init__(self):
        self.intervals: list[float] = []
        self.started = asyncio.Event()

    async def __call__(self, interval: float):
        self.intervals.append(interval)
        self.started.set()
        await asyncio.Future()


def test_runtime_start_schedules_enabled_loops_once_and_skips_disabled():
    async def scenario():
        enqueue = FakeDuty()
        cleanup = FakeDuty()
        sleep = BlockingSleep()
        coordinator = RuntimeCoordinator(
            loops=[
                RuntimeLoop(name="enqueue", interval_seconds=5, enabled=True, duty=enqueue),
                RuntimeLoop(name="cleanup", interval_seconds=30, enabled=False, duty=cleanup),
            ],
            sleep=sleep,
        )

        await coordinator.start()
        await sleep.started.wait()
        await coordinator.start()

        assert coordinator.status() == {
            "status": "ready",
            "enabled": ["enqueue"],
            "running": ["enqueue"],
            "disabled": ["cleanup"],
        }
        assert enqueue.calls == 1
        assert cleanup.calls == 0
        assert sleep.intervals == [5]
        await coordinator.stop()

    asyncio.run(scenario())


def test_runtime_start_schedules_catchup_loop_once_with_other_enabled_duties():
    async def scenario():
        enqueue = FakeDuty()
        catchup = FakeDuty()
        sleep = BlockingSleep()
        coordinator = RuntimeCoordinator(
            loops=[
                RuntimeLoop(name="enqueue", interval_seconds=5, enabled=True, duty=enqueue),
                RuntimeLoop(name="catchup", interval_seconds=3600, enabled=True, duty=catchup),
            ],
            sleep=sleep,
        )

        await coordinator.start()
        await sleep.started.wait()
        await coordinator.start()

        status = coordinator.status()
        assert status["enabled"] == ["enqueue", "catchup"]
        assert set(status["running"]) == {"enqueue", "catchup"}
        assert enqueue.calls == 1
        assert catchup.calls == 1
        await coordinator.stop()

    asyncio.run(scenario())


def test_runtime_waits_initial_delay_before_first_duty():
    async def scenario():
        duty = FakeDuty()
        sleep = BlockingSleep()
        coordinator = RuntimeCoordinator(
            loops=[
                RuntimeLoop(
                    name="catchup",
                    interval_seconds=3600,
                    initial_delay_seconds=300,
                    enabled=True,
                    duty=duty,
                ),
            ],
            sleep=sleep,
        )

        await coordinator.start()
        await sleep.started.wait()

        assert sleep.intervals == [300]
        assert duty.calls == 0

        await coordinator.stop()
        assert coordinator.status()["running"] == []

    asyncio.run(scenario())


def test_runtime_status_can_report_classification_loop_disabled_by_configuration():
    coordinator = RuntimeCoordinator(
        loops=[RuntimeLoop(name="classification_backfill", interval_seconds=3600, enabled=False, duty=lambda: None)]
    )

    assert coordinator.status() == {
        "status": "ready",
        "enabled": [],
        "running": [],
        "disabled": ["classification_backfill"],
    }



def test_build_runtime_coordinator_applies_initial_delay_only_to_catchup(tmp_path):
    settings = Settings(
        db_path=tmp_path / "monitor.sqlite3",
        radar_url="",
        radar_api_key="",
        worker_catchup_initial_delay_seconds=123,
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    coordinator = _build_runtime_coordinator(settings=settings, store=store, discovery_worker=None, radar_client=None)

    delays = {loop.name: loop.initial_delay_seconds for loop in coordinator._loops}
    assert delays["catchup"] == 123
    assert all(delay == 0 for name, delay in delays.items() if name != "catchup")


def test_runtime_stop_cancels_and_awaits_running_loops():
    async def scenario():
        sleep = BlockingSleep()
        duty = FakeDuty()
        coordinator = RuntimeCoordinator(
            loops=[RuntimeLoop(name="pending_live", interval_seconds=2, enabled=True, duty=duty)],
            sleep=sleep,
        )

        await coordinator.start()
        await sleep.started.wait()
        await coordinator.stop()

        assert coordinator.status()["running"] == []
        assert duty.calls == 1

    asyncio.run(scenario())


def test_runtime_logs_exceptions_and_retries_after_interval(caplog):
    async def scenario():
        sleeps: list[float] = []

        async def sleep(interval: float):
            sleeps.append(interval)
            raise asyncio.CancelledError()

        duty = FakeDuty(fail_once=True)
        coordinator = RuntimeCoordinator(
            loops=[RuntimeLoop(name="cleanup", interval_seconds=11, enabled=True, duty=duty)],
            sleep=sleep,
            logger=logging.getLogger("test-runtime"),
        )

        with caplog.at_level(logging.ERROR, logger="test-runtime"):
            await coordinator.start()
            await asyncio.sleep(0)

        assert sleeps == [11]
        assert "Runtime duty failed: cleanup" in caplog.text
        assert coordinator.status()["running"] == []

    asyncio.run(scenario())


def test_runtime_offloads_synchronous_duties_without_blocking_event_loop():
    async def scenario():
        loop = asyncio.get_running_loop()
        started = asyncio.Event()
        release = threading.Event()
        calls = 0

        def blocking_duty():
            nonlocal calls
            calls += 1
            loop.call_soon_threadsafe(started.set)
            while not release.is_set():
                time.sleep(0.01)

        coordinator = RuntimeCoordinator(
            loops=[RuntimeLoop(name="catchup", interval_seconds=3600, enabled=True, duty=blocking_duty)],
            sleep=asyncio.sleep,
        )

        await coordinator.start()
        await asyncio.wait_for(started.wait(), timeout=1)
        await asyncio.wait_for(asyncio.sleep(0), timeout=1)

        assert calls == 1
        assert coordinator.status()["running"] == ["catchup"]

        release.set()
        await asyncio.wait_for(coordinator.stop(), timeout=1)

    asyncio.run(scenario())
