from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BoundaryProviderError(Exception):
    code: str
    message: str
    retryable: bool = False
    status: int = 400
