from __future__ import annotations

import sqlite3
import json
import shutil
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country


REQUIRED_TABLES = [
    "channels",
    "videos",
    "enqueue_attempts",
    "video_target_matches",
    "rejected_videos",
    "cleanup_runs",
    "classification_runs",
    "important_summary_mentions",
    "card_context_dismissals",
]

PROTECTED_TARGET_STATUSES = {"transcribiendo", "transcrito", "error", "geo_blocked"}
PROTECTED_BACKFILL_ENQUEUE_STATUSES = {"enqueued", "transcribing", "transcribiendo", "transcrito", "error", "geo_blocked"}


@dataclass(frozen=True)
class ChannelRecord:
    country: str
    label: str
    source_url: str | None
    youtube_channel_id: str
    uploads_playlist_id: str | None = None
    enabled: bool = True
    important: bool = False
    important_mode: str | None = None
    important_rules: list[Any] = field(default_factory=list)
    priority_tier: str | None = None
    algorithm_priority_rank: int | None = None
    baseline_started_at: str | None = None
    last_seen_published_at: str | None = None
    last_catchup_error: str | None = None
    last_catchup_at: str | None = None
    id: int | None = None


@dataclass(frozen=True)
class VideoRecord:
    video_id: str
    lifecycle: str
    channel_id: int | None = None
    title: str | None = None
    url: str | None = None
    published_at: str | None = None
    live_status: str | None = None
    matched: bool | None = None
    match_reason: str | None = None
    evaluated_at: str | None = None
    next_poll_at: str | None = None
    classification_version: str | None = None
    classified_at: str | None = None
    classification_status: str | None = None
    classification_reason: str | None = None
    classification_run_id: int | None = None
    important_mode: str | None = None
    important_rule_json: str | None = None
    queue_priority_tier: str | None = None
    queue_priority_rank: int | None = None
    detected_at: str | None = None

    def with_updates(self, **changes: Any) -> "VideoRecord":
        values = self.__dict__ | changes
        return VideoRecord(**values)


@dataclass(frozen=True)
class EnqueueAttemptRecord:
    video_id: str
    status: str
    attempt_count: int
    radar_job_id: str | None = None
    next_attempt_at: str | None = None
    last_error: str | None = None
    queue_priority_tier: str | None = None
    queue_priority_rank: int | None = None
    id: int | None = None


@dataclass(frozen=True)
class TargetMatchRecord:
    video_id: str
    target_country: str
    status: str
    title_match_reason: str | None = None
    radar_job_id: str | None = None
    mention_counts_json: str | None = None
    last_error: str | None = None
    classification_version: str | None = None
    classified_at: str | None = None
    classification_run_id: int | None = None
    approval_source: str | None = None
    queue_priority_tier: str | None = None
    queue_priority_rank: int | None = None
    id: int | None = None

    def with_updates(self, **changes: Any) -> "TargetMatchRecord":
        values = self.__dict__ | changes
        return TargetMatchRecord(**values)


@dataclass(frozen=True)
class RejectedVideoRecord:
    video_id: str
    source_country: str | None
    reason: str
    title: str | None = None
    url: str | None = None
    channel_label: str | None = None
    published_at: str | None = None
    match_reason_json: str | None = None
    classification_version: str | None = None
    classified_at: str | None = None
    classification_run_id: int | None = None
    id: int | None = None


@dataclass(frozen=True)
class ClassificationCandidateRecord:
    video: VideoRecord
    source_country: str | None


@dataclass(frozen=True)
class ClassificationRunRecord:
    id: int
    classification_version: str
    mode: str
    status: str
    started_at: str
    completed_at: str | None
    candidate_count: int
    would_create_matches: int
    would_create_rejections: int
    created_or_updated_matches: int
    created_or_updated_rejections: int
    skipped_in_flight: int
    error: str | None
    parameters_json: str | None


@dataclass(frozen=True)
class RejectedVideoPage:
    total: int
    items: list[RejectedVideoRecord]


@dataclass(frozen=True)
class MonitorCardRecord:
    video_id: str
    title: str | None
    country: str | None
    channel_label: str | None
    published_at: str | None
    lifecycle: str
    matched: bool | None
    enqueue_status: str | None
    radar_job_id: str | None
    attempt_count: int | None
    last_error: str | None


@dataclass(frozen=True)
class CleanupRunRecord:
    started_at: str
    deleted_count: int
    error: str | None = None
    id: int | None = None


@dataclass(frozen=True)
class RetentionDryRunItem:
    video_id: str
    url: str | None
    detected_at: str
    lifecycle: str
    states: dict[str, Any]
    transcript_refs: dict[str, list[str]]
    planned_deletions: dict[str, int]
    transcript_artifacts: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class RetentionDryRunReport:
    mode: str
    cutoff: str
    items: list[RetentionDryRunItem]

    @property
    def summary(self) -> dict[str, Any]:
        totals = _empty_retention_deletion_counts()
        for item in self.items:
            for key, value in item.planned_deletions.items():
                totals[key] = totals.get(key, 0) + int(value)
        return {"mode": self.mode, "cutoff": self.cutoff, "video_count": len(self.items), "planned_deletions": totals}


def _empty_retention_deletion_counts() -> dict[str, int]:
    return {
        "videos": 0,
        "enqueue_attempts": 0,
        "video_target_matches": 0,
        "rejected_videos": 0,
        "card_context_dismissals": 0,
        "transcript_artifacts": 0,
    }
