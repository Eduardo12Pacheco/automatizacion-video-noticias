from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


Duty = Callable[[], Any]
Sleep = Callable[[float], Awaitable[None]]


@dataclass(frozen=True)
class RuntimeLoop:
    name: str
    interval_seconds: int
    enabled: bool
    duty: Duty


class RuntimeCoordinator:
    def __init__(
        self,
        *,
        loops: list[RuntimeLoop],
        sleep: Sleep = asyncio.sleep,
        logger: logging.Logger | None = None,
    ):
        self._loops = loops
        self._sleep = sleep
        self._logger = logger or logging.getLogger(__name__)
        self._tasks: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        async with self._lock:
            self._tasks = {name: task for name, task in self._tasks.items() if not task.done()}
            for loop in self._loops:
                if not loop.enabled or loop.name in self._tasks:
                    continue
                self._tasks[loop.name] = asyncio.create_task(self._run_loop(loop), name=f"monitor-{loop.name}")

    async def stop(self) -> None:
        async with self._lock:
            tasks = list(self._tasks.values())
            self._tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def status(self) -> dict[str, list[str] | str]:
        running = [name for name, task in self._tasks.items() if not task.done()]
        return {
            "status": "ready",
            "enabled": [loop.name for loop in self._loops if loop.enabled],
            "running": running,
            "disabled": [loop.name for loop in self._loops if not loop.enabled],
        }

    async def _run_loop(self, loop: RuntimeLoop) -> None:
        try:
            while True:
                try:
                    await _run_duty(loop.duty)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self._logger.exception("Runtime duty failed: %s", loop.name)
                await self._sleep(loop.interval_seconds)
        except asyncio.CancelledError:
            raise
        finally:
            current = asyncio.current_task()
            if self._tasks.get(loop.name) is current:
                self._tasks.pop(loop.name, None)


async def _run_duty(duty: Duty) -> None:
    if inspect.iscoroutinefunction(duty) or inspect.iscoroutinefunction(getattr(duty, "__call__", None)):
        await duty()
        return
    await asyncio.to_thread(duty)
