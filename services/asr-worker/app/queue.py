from __future__ import annotations


class InlineJobQueue:
    def __init__(self, worker):
        self.worker = worker

    @property
    def busy(self) -> bool:
        return bool(getattr(self.worker, "busy", False))

    @property
    def queue_depth(self) -> int:
        return int(getattr(self.worker, "queue_depth", 0))

    def enqueue(self, job_id: str) -> None:
        self.worker.enqueue(job_id)
