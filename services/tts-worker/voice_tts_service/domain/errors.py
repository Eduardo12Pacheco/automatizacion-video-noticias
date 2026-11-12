from __future__ import annotations


class QueueFullError(RuntimeError):
    """Raised when the worker queue is full."""
