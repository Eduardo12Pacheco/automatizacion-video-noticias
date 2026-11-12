from __future__ import annotations

import threading
import time
from collections import deque


class SlidingWindowRateLimiter:
    def __init__(self, max_per_minute: int):
        self.max_per_minute = max_per_minute
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = {}

    def allow(self, key: str) -> tuple[bool, int]:
        now = time.time()
        threshold = now - 60.0
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and q[0] < threshold:
                q.popleft()
            if len(q) >= self.max_per_minute:
                retry_after = max(1, int(60 - (now - q[0])))
                return False, retry_after
            q.append(now)
            return True, 0
