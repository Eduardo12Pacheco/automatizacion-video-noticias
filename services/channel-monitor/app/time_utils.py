"""ISO-8601 helpers shared by the channel monitor workers and retention jobs."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta


def now_iso() -> str:
    return datetime.now(tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def utc_now_iso() -> str:
    """Timestamp with microseconds, used by bootstrap and maintenance paths."""
    return datetime.now(tz=UTC).isoformat().replace("+00:00", "Z")


def add_minutes(value: str, minutes: int) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parsed + timedelta(minutes=minutes)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def add_seconds(value: str, seconds: int) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parsed + timedelta(seconds=seconds)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def iso_lte(left: str, right: str) -> bool:
    return parse_iso(left) <= parse_iso(right)


def iso_lt(left: str, right: str) -> bool:
    return parse_iso(left) < parse_iso(right)


def iso_equal(left: str, right: str) -> bool:
    return parse_iso(left) == parse_iso(right)


def iso_gt(left: str, right: str) -> bool:
    return parse_iso(left) > parse_iso(right)
