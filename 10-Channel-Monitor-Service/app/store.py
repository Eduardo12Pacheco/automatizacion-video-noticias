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
    "subscriptions",
    "boundary_websub_events",
    "cleanup_runs",
    "classification_runs",
    "ai_rescue_queue",
    "ai_rescue_candidates",
    "ai_rescue_evidence",
    "ai_rescue_decisions",
    "ai_rescue_rejections",
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
class AiRescueQueueRecord:
    video_id: str
    source_country: str | None
    status: str
    attempt_count: int
    next_attempt_at: str | None = None
    last_error: str | None = None
    id: int | None = None


@dataclass(frozen=True)
class AiRescueEvidenceRecord:
    candidate_id: int
    start_ms: int
    end_ms: int
    text: str
    translation_es: str
    explanation_es: str
    id: int | None = None


@dataclass(frozen=True)
class AiRescueCandidateRecord:
    queue_id: int
    video_id: str
    target_country: str
    status: str
    score: int
    summary_es: str
    angle_es: str
    risk: str
    risks_json: str | None = None
    raw_response_json: str | None = None
    evidence: list[AiRescueEvidenceRecord] = field(default_factory=list)
    id: int | None = None


@dataclass(frozen=True)
class AiRescueDecisionRecord:
    candidate_id: int
    decision: str
    reviewer: str | None
    reason: str | None
    decided_at: str
    id: int | None = None


@dataclass(frozen=True)
class AiRescueRejectionRecord:
    video_id: str
    source: str
    reason: str
    queue_id: int | None = None
    candidate_id: int | None = None
    target_country: str | None = None
    details_json: str | None = None
    id: int | None = None


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


@dataclass(frozen=True)
class SubscriptionRecord:
    channel_id: int
    callback_url: str
    lease_seconds: int | None = None
    expires_at: str | None = None
    last_renewed_at: str | None = None
    status: str = "ready"
    last_error: str | None = None


class MonitorStore:
    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self._channel_importance: dict[str, tuple[str | None, list[Any]]] = {}

    def migrate(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                create table if not exists channels (
                    id integer primary key autoincrement,
                    country text not null,
                    label text not null,
                    source_url text,
                    youtube_channel_id text not null unique,
                    uploads_playlist_id text,
                    enabled integer not null default 1,
                    important integer not null default 0,
                    priority_tier text,
                    algorithm_priority_rank integer,
                    baseline_started_at text,
                    last_seen_published_at text,
                    last_catchup_error text,
                    last_catchup_at text,
                    last_seen_at text,
                    created_at text not null default current_timestamp,
                    updated_at text not null default current_timestamp
                );

                create table if not exists videos (
                    video_id text primary key,
                    channel_id integer references channels(id),
                    title text,
                    url text,
                    published_at text,
                    live_status text,
                    lifecycle text not null,
                    matched integer,
                    match_reason text,
                    evaluated_at text,
                    next_poll_at text,
                    classification_version text,
                    classified_at text,
                    classification_status text,
                    classification_reason text,
                    classification_run_id integer,
                    important_mode text,
                    important_rule_json text,
                    queue_priority_tier text,
                    queue_priority_rank integer,
                    detected_at text not null default current_timestamp,
                    created_at text not null default current_timestamp,
                    updated_at text not null default current_timestamp
                );

                create table if not exists enqueue_attempts (
                    id integer primary key autoincrement,
                    video_id text not null references videos(video_id),
                    status text not null,
                    radar_job_id text,
                    attempt_count integer not null default 0,
                    next_attempt_at text,
                    last_error text,
                    queue_priority_tier text,
                    queue_priority_rank integer,
                    created_at text not null default current_timestamp,
                    updated_at text not null default current_timestamp
                );

                create table if not exists video_target_matches (
                    id integer primary key autoincrement,
                    video_id text not null references videos(video_id),
                    target_country text not null,
                    status text not null,
                    title_match_reason text,
                    radar_job_id text,
                    mention_counts_json text,
                    last_error text,
                    classification_version text,
                    classified_at text,
                    classification_run_id integer,
                    approval_source text not null default 'title_classifier',
                    queue_priority_tier text,
                    queue_priority_rank integer,
                    created_at text not null default current_timestamp,
                    updated_at text not null default current_timestamp,
                    unique(video_id, target_country)
                );

                create table if not exists important_summary_mentions (
                    video_id text primary key references videos(video_id),
                    radar_job_id text,
                    mention_counts_json text not null default '[]',
                    updated_at text not null default current_timestamp
                );

                create table if not exists rejected_videos (
                    id integer primary key autoincrement,
                    video_id text not null references videos(video_id) unique,
                    source_country text,
                    reason text not null,
                    match_reason_json text,
                    classification_version text,
                    classified_at text,
                    classification_run_id integer,
                    created_at text not null default current_timestamp,
                    updated_at text not null default current_timestamp
                );

                create table if not exists classification_runs (
                    id integer primary key autoincrement,
                    classification_version text not null,
                    mode text not null,
                    status text not null default 'running',
                    started_at text not null default current_timestamp,
                    completed_at text,
                    candidate_count integer not null default 0,
                    would_create_matches integer not null default 0,
                    would_create_rejections integer not null default 0,
                    created_or_updated_matches integer not null default 0,
                    created_or_updated_rejections integer not null default 0,
                    skipped_in_flight integer not null default 0,
                    error text,
                    parameters_json text
                );

                create table if not exists subscriptions (
                    channel_id integer primary key references channels(id),
                    callback_url text not null,
                    lease_seconds integer,
                    expires_at text,
                    last_renewed_at text,
                    status text not null default 'ready',
                    last_error text
                );

                create table if not exists boundary_websub_events (
                    event_id text primary key,
                    channel_id text,
                    video_ids_json text not null,
                    received_at text not null,
                    created_at text not null default current_timestamp
                );

                create table if not exists cleanup_runs (
                    id integer primary key autoincrement,
                    started_at text not null,
                    deleted_count integer not null default 0,
                    error text
                );

                create table if not exists ai_rescue_queue (
                    id integer primary key autoincrement,
                    rejected_video_id integer references rejected_videos(id),
                    video_id text not null references videos(video_id) unique,
                    source_country text,
                    status text not null default 'waiting',
                    attempt_count integer not null default 0,
                    next_attempt_at text,
                    last_error text,
                    started_at text,
                    completed_at text,
                    created_at text not null default current_timestamp,
                    updated_at text not null default current_timestamp
                );

                create table if not exists ai_rescue_candidates (
                    id integer primary key autoincrement,
                    queue_id integer not null references ai_rescue_queue(id),
                    video_id text not null references videos(video_id),
                    target_country text not null,
                    status text not null default 'candidate',
                    score integer not null,
                    summary_es text not null,
                    angle_es text not null,
                    risk text not null,
                    risks_json text,
                    raw_response_json text,
                    created_at text not null default current_timestamp,
                    updated_at text not null default current_timestamp
                );

                create table if not exists ai_rescue_evidence (
                    id integer primary key autoincrement,
                    candidate_id integer not null references ai_rescue_candidates(id) on delete cascade,
                    start_ms integer not null,
                    end_ms integer not null,
                    text text not null,
                    translation_es text not null,
                    explanation_es text not null,
                    created_at text not null default current_timestamp
                );

                create table if not exists ai_rescue_decisions (
                    id integer primary key autoincrement,
                    candidate_id integer not null references ai_rescue_candidates(id),
                    decision text not null,
                    reviewer text,
                    reason text,
                    decided_at text not null,
                    created_at text not null default current_timestamp
                );

                create table if not exists ai_rescue_rejections (
                    id integer primary key autoincrement,
                    queue_id integer references ai_rescue_queue(id),
                    video_id text not null references videos(video_id),
                    candidate_id integer references ai_rescue_candidates(id),
                    target_country text,
                    source text not null,
                    reason text not null,
                    details_json text,
                    created_at text not null default current_timestamp
                );

                create table if not exists card_context_dismissals (
                    id integer primary key autoincrement,
                    surface text not null,
                    target_context text not null,
                    video_id text references videos(video_id),
                    candidate_id integer references ai_rescue_candidates(id),
                    dismissed_at text not null,
                    dismissed_by text,
                    reason text,
                    expires_at text,
                    created_at text not null default current_timestamp,
                    updated_at text not null default current_timestamp,
                    check (video_id is not null or candidate_id is not null)
                );

                create unique index if not exists idx_card_context_dismissals_video_context
                on card_context_dismissals(surface, target_context, video_id)
                where video_id is not null and candidate_id is null;

                create unique index if not exists idx_card_context_dismissals_candidate_context
                on card_context_dismissals(surface, target_context, candidate_id)
                where candidate_id is not null;
                """
            )
            self._ensure_subscription_columns(connection)
            self._ensure_channel_importance_columns(connection)
            self._ensure_classification_columns(connection)
            self._ensure_important_audit_columns(connection)
            self._ensure_retention_columns(connection)
            self._ensure_channel_checkpoint_columns(connection)

    def record_boundary_websub_event(
        self,
        *,
        event_id: str,
        channel_id: str | None,
        video_ids: list[str],
        received_at: str,
    ) -> bool:
        """Persist a normalized boundary WebSub event.

        Returns True for a new event and False when the event_id was already
        recorded, allowing replay-safe callback forwarding.
        """
        with self._connect() as connection:
            cursor = connection.execute(
                """
                insert or ignore into boundary_websub_events(event_id, channel_id, video_ids_json, received_at)
                values (?, ?, ?, ?)
                """,
                (event_id, channel_id, json.dumps(video_ids), received_at),
            )
            return cursor.rowcount == 1

    def get_boundary_websub_event(self, event_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("select * from boundary_websub_events where event_id = ?", (event_id,)).fetchone()
        if row is None:
            return None
        return {
            "event_id": row["event_id"],
            "channel_id": row["channel_id"],
            "video_ids": json.loads(row["video_ids_json"]),
            "received_at": row["received_at"],
        }

    def upsert_card_context_dismissal(
        self,
        *,
        surface: str,
        target_context: str,
        video_id: str | None = None,
        candidate_id: int | None = None,
        dismissed_at: str,
        dismissed_by: str | None = None,
        reason: str | None = None,
        expires_at: str | None = None,
    ) -> dict[str, Any]:
        normalized_surface = _normalize_dismissal_surface(surface)
        normalized_context = _normalize_dismissal_context(target_context)
        normalized_video_id = _optional_stripped(video_id)
        if normalized_video_id is None and candidate_id is None:
            raise ValueError("missing_dismissal_subject")
        resolved_expires_at = expires_at or self._dismissal_expires_at(video_id=normalized_video_id)
        with self._connect() as connection:
            if candidate_id is not None:
                existing = connection.execute(
                    """
                    select id from card_context_dismissals
                    where surface = ? and target_context = ? and candidate_id = ?
                    """,
                    (normalized_surface, normalized_context, candidate_id),
                ).fetchone()
            else:
                existing = connection.execute(
                    """
                    select id from card_context_dismissals
                    where surface = ? and target_context = ? and video_id = ? and candidate_id is null
                    """,
                    (normalized_surface, normalized_context, normalized_video_id),
                ).fetchone()
            if existing is not None:
                dismissal_id = int(existing["id"])
                connection.execute(
                    """
                    update card_context_dismissals
                    set video_id = ?, candidate_id = ?, dismissed_at = ?, dismissed_by = ?, reason = ?, expires_at = ?, updated_at = current_timestamp
                    where id = ?
                    """,
                    (normalized_video_id, candidate_id, dismissed_at, dismissed_by, reason, resolved_expires_at, dismissal_id),
                )
            else:
                cursor = connection.execute(
                    """
                    insert into card_context_dismissals(surface, target_context, video_id, candidate_id, dismissed_at, dismissed_by, reason, expires_at)
                    values (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (normalized_surface, normalized_context, normalized_video_id, candidate_id, dismissed_at, dismissed_by, reason, resolved_expires_at),
                )
                dismissal_id = int(cursor.lastrowid)
        return {
            "id": dismissal_id,
            "status": "dismissed",
            "context_key": _dismissal_context_key(
                surface=normalized_surface,
                target_context=normalized_context,
                video_id=normalized_video_id,
                candidate_id=candidate_id,
            ),
            "expires_at": resolved_expires_at,
        }

    def upsert_channel(self, record: ChannelRecord) -> ChannelRecord:
        with self._connect() as connection:
            connection.execute(
                """
                insert into channels(
                    country, label, source_url, youtube_channel_id, uploads_playlist_id,
                    enabled, important, priority_tier, algorithm_priority_rank, important_mode, important_rules_json
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(youtube_channel_id) do update set
                    country = excluded.country,
                    label = excluded.label,
                    source_url = excluded.source_url,
                    uploads_playlist_id = excluded.uploads_playlist_id,
                    enabled = excluded.enabled,
                    important = excluded.important,
                    priority_tier = excluded.priority_tier,
                    algorithm_priority_rank = excluded.algorithm_priority_rank,
                    important_mode = excluded.important_mode,
                    important_rules_json = excluded.important_rules_json,
                    updated_at = current_timestamp
                """,
                (
                    record.country,
                    record.label,
                    record.source_url,
                    record.youtube_channel_id,
                    record.uploads_playlist_id,
                    1 if record.enabled else 0,
                    1 if record.important else 0,
                    record.priority_tier,
                    record.algorithm_priority_rank,
                    record.important_mode,
                    _json_dumps_compact([_plain_json_value(rule) for rule in record.important_rules]) if record.important_rules else None,
                ),
            )
            self._remember_channel_importance(record)
            row = connection.execute(
                "select * from channels where youtube_channel_id = ?", (record.youtube_channel_id,)
            ).fetchone()
        return self._with_channel_importance(_channel_from_row(row))

    def list_channels(self) -> list[ChannelRecord]:
        with self._connect() as connection:
            rows = connection.execute("select * from channels order by id").fetchall()
        return [self._with_channel_importance(_channel_from_row(row)) for row in rows]

    def stamp_channel_baseline(self, channel_id: int, *, baseline_started_at: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                update channels
                set baseline_started_at = ?,
                    last_seen_published_at = null,
                    last_catchup_error = null,
                    last_catchup_at = null,
                    updated_at = current_timestamp
                where id = ?
                """,
                (baseline_started_at, channel_id),
            )

    def advance_channel_catchup_checkpoint(self, channel_id: int, *, published_at: str, caught_up_at: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                update channels
                set last_seen_published_at = case
                        when last_seen_published_at is null
                          or datetime(replace(replace(?, 'T', ' '), 'Z', '')) > datetime(replace(replace(last_seen_published_at, 'T', ' '), 'Z', ''))
                        then ? else last_seen_published_at end,
                    last_catchup_error = null,
                    last_catchup_at = ?,
                    updated_at = current_timestamp
                where id = ?
                """,
                (published_at, published_at, caught_up_at, channel_id),
            )

    def record_channel_catchup_error(self, channel_id: int, *, error: str, caught_up_at: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                update channels
                set last_catchup_error = ?, last_catchup_at = ?, updated_at = current_timestamp
                where id = ?
                """,
                (error, caught_up_at, channel_id),
            )

    def reset_radar_baseline(self, *, mode: str, backup_path: Path | str, baseline_started_at: str) -> dict[str, Any]:
        if mode not in {"dry-run", "apply"}:
            raise ValueError("mode must be dry-run or apply")
        backup = Path(backup_path)
        counts = self._operational_state_counts()
        channels_to_stamp = self.list_catchup_channels()
        report: dict[str, Any] = {
            "status": "dry-run" if mode == "dry-run" else "applied",
            "backup_path": str(backup),
            "backup_exists": backup.exists(),
            "baseline_started_at": baseline_started_at,
            "channels_stamped": len(channels_to_stamp),
            "videos_planned": counts["videos"],
            "videos_deleted": 0,
            "deletion_summary": counts,
        }
        if mode == "dry-run":
            return report
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.db_path, backup)
        with self._connect() as connection:
            video_ids = [str(row["video_id"]) for row in connection.execute("select video_id from videos order by video_id").fetchall()]
        deleted = _empty_retention_deletion_counts()
        for video_id in video_ids:
            item_counts = self.delete_detected_video_state(video_id)
            for key, value in item_counts.items():
                deleted[key] = deleted.get(key, 0) + value
        for channel in channels_to_stamp:
            if channel.id is not None:
                self.stamp_channel_baseline(channel.id, baseline_started_at=baseline_started_at)
        report["backup_exists"] = backup.exists()
        report["videos_deleted"] = deleted["videos"]
        report["deletion_summary"] = deleted
        return report

    def _operational_state_counts(self) -> dict[str, int]:
        counts = _empty_retention_deletion_counts()
        with self._connect() as connection:
            for table in ["videos", "enqueue_attempts", "video_target_matches", "rejected_videos", "card_context_dismissals", "ai_rescue_queue", "ai_rescue_candidates", "ai_rescue_evidence", "ai_rescue_decisions", "ai_rescue_rejections"]:
                counts[table] = int(connection.execute(f"select count(*) as total from {table}").fetchone()["total"])
        return counts

    def list_catchup_channels(self) -> list[ChannelRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                select * from channels
                where enabled = 1
                  and uploads_playlist_id is not null
                  and trim(uploads_playlist_id) != ''
                order by id
                """
            ).fetchall()
        return [self._with_channel_importance(_channel_from_row(row)) for row in rows]

    def find_channel_by_youtube_id(self, youtube_channel_id: str) -> ChannelRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "select * from channels where youtube_channel_id = ?", (youtube_channel_id,)
            ).fetchone()
        return self._with_channel_importance(_channel_from_row(row)) if row else None

    def find_channel_by_id(self, channel_id: int) -> ChannelRecord | None:
        with self._connect() as connection:
            row = connection.execute("select * from channels where id = ?", (channel_id,)).fetchone()
        return self._with_channel_importance(_channel_from_row(row)) if row else None

    def update_channel(
        self,
        channel_id: int,
        *,
        country: str | None = None,
        label: str | None = None,
        enabled: bool | None = None,
    ) -> ChannelRecord | None:
        existing = self.find_channel_by_id(channel_id)
        if existing is None:
            return None
        updated = ChannelRecord(
            id=existing.id,
            country=country if country is not None else existing.country,
            label=label if label is not None else existing.label,
            source_url=existing.source_url,
            youtube_channel_id=existing.youtube_channel_id,
            uploads_playlist_id=existing.uploads_playlist_id,
            enabled=enabled if enabled is not None else existing.enabled,
            important=existing.important,
            priority_tier=existing.priority_tier,
            algorithm_priority_rank=existing.algorithm_priority_rank,
            important_mode=existing.important_mode,
            important_rules=existing.important_rules,
        )
        return self.upsert_channel(updated)

    def upsert_video(self, record: VideoRecord) -> VideoRecord:
        with self._connect() as connection:
            connection.execute(
                """
                insert into videos(
                    video_id, channel_id, title, url, published_at, live_status, lifecycle,
                    matched, match_reason, evaluated_at, next_poll_at,
                    classification_version, classified_at, classification_status,
                    classification_reason, classification_run_id, important_mode, important_rule_json,
                    queue_priority_tier, queue_priority_rank, detected_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, current_timestamp))
                on conflict(video_id) do update set
                    channel_id = excluded.channel_id,
                    title = excluded.title,
                    url = excluded.url,
                    published_at = excluded.published_at,
                    live_status = excluded.live_status,
                    lifecycle = excluded.lifecycle,
                    matched = excluded.matched,
                    match_reason = excluded.match_reason,
                    evaluated_at = excluded.evaluated_at,
                    next_poll_at = excluded.next_poll_at,
                    classification_version = coalesce(excluded.classification_version, videos.classification_version),
                    classified_at = coalesce(excluded.classified_at, videos.classified_at),
                    classification_status = coalesce(excluded.classification_status, videos.classification_status),
                    classification_reason = coalesce(excluded.classification_reason, videos.classification_reason),
                    classification_run_id = coalesce(excluded.classification_run_id, videos.classification_run_id),
                    important_mode = coalesce(excluded.important_mode, videos.important_mode),
                    important_rule_json = coalesce(excluded.important_rule_json, videos.important_rule_json),
                    queue_priority_tier = coalesce(excluded.queue_priority_tier, videos.queue_priority_tier),
                    queue_priority_rank = coalesce(excluded.queue_priority_rank, videos.queue_priority_rank),
                    updated_at = current_timestamp
                """,
                (
                    record.video_id,
                    record.channel_id,
                    record.title,
                    record.url,
                    record.published_at,
                    record.live_status,
                    record.lifecycle,
                    _bool_to_db(record.matched),
                    record.match_reason,
                    record.evaluated_at,
                    record.next_poll_at,
                    record.classification_version,
                    record.classified_at,
                    record.classification_status,
                    record.classification_reason,
                    record.classification_run_id,
                    record.important_mode,
                    record.important_rule_json,
                    record.queue_priority_tier,
                    record.queue_priority_rank,
                    record.detected_at,
                ),
            )
            row = connection.execute("select * from videos where video_id = ?", (record.video_id,)).fetchone()
        return _video_from_row(row)

    def get_video(self, video_id: str) -> VideoRecord | None:
        with self._connect() as connection:
            row = connection.execute("select * from videos where video_id = ?", (video_id,)).fetchone()
        return _video_from_row(row) if row else None

    def list_pending_live(self) -> list[VideoRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "select * from videos where lifecycle = 'pending_live' order by created_at, video_id"
            ).fetchall()
        return [_video_from_row(row) for row in rows]

    def list_due_enqueue(self, now: str) -> list[VideoRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                select videos.*
                from videos
                left join channels on channels.id = videos.channel_id
                left join video_target_matches matches on matches.video_id = videos.video_id
                where videos.lifecycle = 'enqueue_pending'
                  and (
                    matches.status = 'aprobado'
                    or (
                      videos.matched = 1
                      and not exists (select 1 from video_target_matches where video_id = videos.video_id)
                      and (
                        videos.queue_priority_tier = 'important'
                        or videos.important_mode is not null
                        or videos.classification_status in ('important', 'important_channel')
                        or channels.important = 1
                      )
                    )
                  )
                  and not exists (
                    select 1
                    from enqueue_attempts latest
                    where latest.video_id = videos.video_id
                      and latest.id = (
                        select max(id) from enqueue_attempts where video_id = videos.video_id
                      )
                      and latest.next_attempt_at is not null
                      and latest.next_attempt_at > ?
                  )
                order by
                    case
                        when videos.queue_priority_tier = 'important'
                          or videos.important_mode is not null
                          or videos.classification_status in ('important', 'important_channel')
                          or channels.important = 1 then 0
                        else 1
                    end,
                    case matches.target_country
                        when 'ecuador' then 1
                        when 'colombia' then 2
                        when 'argentina' then 3
                        when 'uruguay' then 4
                        when 'paraguay' then 5
                        when 'mexico' then 6
                        else 99
                    end,
                    case when channels.algorithm_priority_rank is null then 1 else 0 end,
                    channels.algorithm_priority_rank asc,
                    videos.created_at,
                    videos.video_id
                limit 1
                """,
                (now,),
            ).fetchall()
            if not rows:
                rows = connection.execute(
                    """
                    select videos.*
                    from videos
                    where videos.lifecycle = 'enqueue_pending'
                      and videos.matched = 1
                      and not exists (select 1 from video_target_matches where video_id = videos.video_id)
                      and not exists (
                        select 1
                        from enqueue_attempts latest
                        where latest.video_id = videos.video_id
                          and latest.id = (
                            select max(id) from enqueue_attempts where video_id = videos.video_id
                          )
                          and latest.next_attempt_at is not null
                          and latest.next_attempt_at > ?
                      )
                    order by videos.created_at, videos.video_id
                    limit 1
                    """,
                    (now,),
                ).fetchall()
        return [_video_from_row(row) for row in rows]

    def make_target_match(
        self,
        *,
        video_id: str,
        target_country: str,
        status: str,
        title_match_reason: str | None = None,
        radar_job_id: str | None = None,
        mention_counts_json: str | None = None,
        last_error: str | None = None,
    ) -> TargetMatchRecord:
        return TargetMatchRecord(
            video_id=video_id,
            target_country=normalize_country(target_country),
            status=status,
            title_match_reason=title_match_reason,
            radar_job_id=radar_job_id,
            mention_counts_json=mention_counts_json,
            last_error=last_error,
            approval_source="title_classifier",
        )

    def upsert_target_match(self, record: TargetMatchRecord) -> TargetMatchRecord:
        target_country = normalize_country(record.target_country)
        with self._connect() as connection:
            queue_priority_tier = record.queue_priority_tier
            queue_priority_rank = record.queue_priority_rank
            if queue_priority_tier is None or queue_priority_rank is None:
                computed = _target_queue_priority(connection, video_id=record.video_id, target_country=target_country)
                queue_priority_tier = queue_priority_tier or computed["tier"]
                queue_priority_rank = queue_priority_rank if queue_priority_rank is not None else computed["rank"]
            connection.execute(
                """
                insert into video_target_matches(
                    video_id, target_country, status, title_match_reason, radar_job_id, mention_counts_json,
                    last_error, classification_version, classified_at, classification_run_id, approval_source,
                    queue_priority_tier, queue_priority_rank
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(video_id, target_country) do update set
                    status = excluded.status,
                    title_match_reason = coalesce(excluded.title_match_reason, video_target_matches.title_match_reason),
                    radar_job_id = coalesce(excluded.radar_job_id, video_target_matches.radar_job_id),
                    mention_counts_json = coalesce(excluded.mention_counts_json, video_target_matches.mention_counts_json),
                    last_error = excluded.last_error,
                    classification_version = coalesce(excluded.classification_version, video_target_matches.classification_version),
                    classified_at = coalesce(excluded.classified_at, video_target_matches.classified_at),
                    classification_run_id = coalesce(excluded.classification_run_id, video_target_matches.classification_run_id),
                    approval_source = coalesce(excluded.approval_source, video_target_matches.approval_source),
                    queue_priority_tier = coalesce(excluded.queue_priority_tier, video_target_matches.queue_priority_tier),
                    queue_priority_rank = coalesce(excluded.queue_priority_rank, video_target_matches.queue_priority_rank),
                    updated_at = current_timestamp
                """,
                (
                    record.video_id,
                    target_country,
                    record.status,
                    record.title_match_reason,
                    record.radar_job_id,
                    record.mention_counts_json,
                    record.last_error,
                    record.classification_version,
                    record.classified_at,
                    record.classification_run_id,
                    record.approval_source or "title_classifier",
                    queue_priority_tier,
                    queue_priority_rank,
                ),
            )
            row = connection.execute(
                "select * from video_target_matches where video_id = ? and target_country = ?",
                (record.video_id, target_country),
            ).fetchone()
        return _target_match_from_row(row)

    def list_target_matches(self, *, video_id: str | None = None) -> list[TargetMatchRecord]:
        where = "where video_id = ?" if video_id else ""
        args: tuple[Any, ...] = (video_id,) if video_id else ()
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                select * from video_target_matches
                {where}
                order by
                    case target_country
                        when 'ecuador' then 1
                        when 'colombia' then 2
                        when 'argentina' then 3
                        when 'uruguay' then 4
                        when 'paraguay' then 5
                        when 'mexico' then 6
                        else 99
                    end,
                    id
                """,
                args,
            ).fetchall()
        return [_target_match_from_row(row) for row in rows]

    def update_target_matches_for_video(
        self,
        video_id: str,
        *,
        status: str,
        radar_job_id: str | None = None,
        mention_counts_json: str | None = None,
        last_error: str | None = None,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                update video_target_matches
                set status = ?,
                    radar_job_id = coalesce(?, radar_job_id),
                    mention_counts_json = coalesce(?, mention_counts_json),
                    last_error = ?,
                    updated_at = current_timestamp
                where video_id = ?
                """,
                (status, radar_job_id, mention_counts_json, last_error, video_id),
            )

    def update_target_matches_from_summary(
        self,
        *,
        video_id: str,
        radar_job_id: str,
        summary: dict[str, Any],
    ) -> list[TargetMatchRecord]:
        video = self.get_video(video_id)
        source_country: str | None = None
        if video and video.channel_id is not None:
            channel = self.find_channel_by_id(video.channel_id)
            source_country = channel.country if channel else None
        items_by_country = _summary_items_by_real_country(summary, exclude_country=source_country)
        with self._connect() as connection:
            existing_rows = connection.execute(
                "select * from video_target_matches where video_id = ? order by id",
                (video_id,),
            ).fetchall()
            existing_countries = {str(row["target_country"]) for row in existing_rows}
            for row in existing_rows:
                target_country = str(row["target_country"])
                connection.execute(
                    """
                    update video_target_matches
                    set status = 'transcrito',
                        radar_job_id = ?,
                        mention_counts_json = ?,
                        last_error = null,
                        updated_at = current_timestamp
                    where id = ?
                    """,
                    (radar_job_id, items_by_country.get(target_country, "[]"), row["id"]),
                )
            for target_country, mention_counts_json in items_by_country.items():
                if target_country in existing_countries:
                    continue
                queue_priority = _target_queue_priority(connection, video_id=video_id, target_country=target_country)
                connection.execute(
                    """
                    insert into video_target_matches(
                        video_id, target_country, status, radar_job_id, mention_counts_json,
                        last_error, classification_version, classified_at, classification_run_id, approval_source,
                        queue_priority_tier, queue_priority_rank
                    )
                    values (?, ?, 'transcrito', ?, ?, null, ?, ?, ?, 'transcript_summary', ?, ?)
                    on conflict(video_id, target_country) do update set
                        status = excluded.status,
                        radar_job_id = excluded.radar_job_id,
                        mention_counts_json = excluded.mention_counts_json,
                        last_error = null,
                        classification_version = coalesce(excluded.classification_version, video_target_matches.classification_version),
                        classified_at = coalesce(excluded.classified_at, video_target_matches.classified_at),
                        classification_run_id = coalesce(excluded.classification_run_id, video_target_matches.classification_run_id),
                        approval_source = coalesce(video_target_matches.approval_source, excluded.approval_source),
                        queue_priority_tier = coalesce(video_target_matches.queue_priority_tier, excluded.queue_priority_tier),
                        queue_priority_rank = coalesce(video_target_matches.queue_priority_rank, excluded.queue_priority_rank),
                        updated_at = current_timestamp
                    """,
                    (
                        video_id,
                        target_country,
                        radar_job_id,
                        mention_counts_json,
                        video.classification_version if video else None,
                        video.classified_at if video else None,
                        video.classification_run_id if video else None,
                        queue_priority["tier"],
                        queue_priority["rank"],
                    ),
                )
            rows = connection.execute(
                """
                select * from video_target_matches
                where video_id = ?
                order by
                    case target_country
                        when 'ecuador' then 1
                        when 'colombia' then 2
                        when 'argentina' then 3
                        when 'uruguay' then 4
                        when 'paraguay' then 5
                        when 'mexico' then 6
                        else 99
                    end,
                    id
                """,
                (video_id,),
            ).fetchall()
        return [_target_match_from_row(row) for row in rows]

    def list_transcribing_video_jobs(self) -> list[dict[str, str]]:
        with self._connect() as connection:
            target_rows = connection.execute(
                """
                select video_id, radar_job_id
                from video_target_matches
                where status = 'transcribiendo'
                  and radar_job_id is not null
                group by video_id, radar_job_id
                order by min(id)
                """
            ).fetchall()
            important_rows = connection.execute(
                """
                select videos.video_id, latest.radar_job_id
                from videos
                join channels on channels.id = videos.channel_id
                join enqueue_attempts latest
                  on latest.video_id = videos.video_id
                 and latest.id = (
                    select max(id) from enqueue_attempts where video_id = videos.video_id
                 )
                where (channels.important = 1 or videos.important_mode is not null or videos.queue_priority_tier = 'important')
                  and latest.status = 'enqueued'
                  and latest.radar_job_id is not null
                  and not exists (
                    select 1
                    from video_target_matches matches
                    where matches.video_id = videos.video_id
                      and matches.status = 'transcribiendo'
                      and matches.radar_job_id is not null
                  )
                order by latest.id
                """
            ).fetchall()
        rows = [*target_rows, *important_rows]
        return [{"video_id": str(row["video_id"]), "radar_job_id": str(row["radar_job_id"])} for row in rows]

    def has_active_transcription(self) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                """
                select exists(
                    select 1
                    from video_target_matches
                    where status = 'transcribiendo'
                ) or exists(
                    select 1
                    from videos
                    join channels on channels.id = videos.channel_id
                    join enqueue_attempts latest
                      on latest.video_id = videos.video_id
                     and latest.id = (
                        select max(id) from enqueue_attempts where video_id = videos.video_id
                     )
                    where (channels.important = 1 or videos.important_mode is not null or videos.queue_priority_tier = 'important')
                      and latest.status = 'enqueued'
                      and latest.radar_job_id is not null
                ) as active
                """
            ).fetchone()
        return bool(row["active"])

    def upsert_important_summary_mentions(self, *, video_id: str, radar_job_id: str, summary: dict[str, Any]) -> str:
        mention_counts_json = _global_summary_mentions_json(summary)
        with self._connect() as connection:
            connection.execute(
                """
                insert into important_summary_mentions(video_id, radar_job_id, mention_counts_json)
                values (?, ?, ?)
                on conflict(video_id) do update set
                    radar_job_id = excluded.radar_job_id,
                    mention_counts_json = excluded.mention_counts_json,
                    updated_at = current_timestamp
                """,
                (video_id, radar_job_id, mention_counts_json),
            )
        return mention_counts_json

    def upsert_important_summary_country_matches(
        self, *, video_id: str, radar_job_id: str, summary: dict[str, Any]
    ) -> list[TargetMatchRecord]:
        video = self.get_video(video_id)
        source_country: str | None = None
        if video and video.channel_id is not None:
            channel = self.find_channel_by_id(video.channel_id)
            source_country = channel.country if channel else None
        created: list[TargetMatchRecord] = []
        for target_country, mention_counts_json in _summary_items_by_real_country(summary, exclude_country=source_country).items():
            created.append(
                self.upsert_target_match(
                    TargetMatchRecord(
                        video_id=video_id,
                        target_country=target_country,
                        status="transcrito",
                        radar_job_id=radar_job_id,
                        mention_counts_json=mention_counts_json,
                        classification_version=video.classification_version if video else None,
                        classified_at=video.classified_at if video else None,
                        classification_run_id=video.classification_run_id if video else None,
                        approval_source="transcript_summary",
                    )
                )
            )
        return created

    def upsert_rejected_video(
        self,
        *,
        video_id: str,
        source_country: str | None,
        reason: str,
        match_reason_json: str | None = None,
        classification_version: str | None = None,
        classified_at: str | None = None,
        classification_run_id: int | None = None,
    ) -> RejectedVideoRecord:
        with self._connect() as connection:
            connection.execute(
                """
                insert into rejected_videos(
                    video_id, source_country, reason, match_reason_json,
                    classification_version, classified_at, classification_run_id
                )
                values (?, ?, ?, ?, ?, ?, ?)
                on conflict(video_id) do update set
                    source_country = excluded.source_country,
                    reason = excluded.reason,
                    match_reason_json = excluded.match_reason_json,
                    classification_version = coalesce(excluded.classification_version, rejected_videos.classification_version),
                    classified_at = coalesce(excluded.classified_at, rejected_videos.classified_at),
                    classification_run_id = coalesce(excluded.classification_run_id, rejected_videos.classification_run_id),
                    updated_at = current_timestamp
                """,
                (
                    video_id,
                    normalize_country(source_country),
                    reason,
                    match_reason_json,
                    classification_version,
                    classified_at,
                    classification_run_id,
                ),
            )
            row = connection.execute(
                _REJECTED_VIDEO_SELECT + " where rejected_videos.video_id = ?",
                (video_id,),
            ).fetchone()
        return _rejected_video_from_row(row)

    def list_rejected_videos(self, *, limit: int = 50, offset: int = 0, now: str | None = None) -> RejectedVideoPage:
        safe_limit = max(1, min(int(limit), 1000))
        safe_offset = max(0, int(offset))
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        with self._connect() as connection:
            total = int(connection.execute(_REJECTED_COUNT_SELECT + f" where {window_sql}", window_args).fetchone()["total"])
            rows = connection.execute(
                _REJECTED_VIDEO_SELECT
                + """
                where {window_sql}
                order by coalesce(videos.published_at, rejected_videos.created_at) desc,
                         rejected_videos.id desc
                limit ? offset ?
                """.format(window_sql=window_sql),
                (*window_args, safe_limit, safe_offset),
            ).fetchall()
        return RejectedVideoPage(total=total, items=[_rejected_video_from_row(row) for row in rows])

    def enqueue_ai_rescue_rejected_video(self, *, video_id: str, now: str | None = None) -> AiRescueQueueRecord:
        with self._connect() as connection:
            rejected = connection.execute(
                "select id, video_id, source_country from rejected_videos where video_id = ?", (video_id,)
            ).fetchone()
            if rejected is None:
                raise KeyError(video_id)
            connection.execute(
                """
                insert into ai_rescue_queue(rejected_video_id, video_id, source_country, status, created_at, updated_at)
                values (?, ?, ?, 'waiting', coalesce(?, current_timestamp), coalesce(?, current_timestamp))
                on conflict(video_id) do nothing
                """,
                (rejected["id"], rejected["video_id"], rejected["source_country"], now, now),
            )
            row = connection.execute("select * from ai_rescue_queue where video_id = ?", (video_id,)).fetchone()
        return _ai_rescue_queue_from_row(row)

    def list_ai_rescue_queue(self, *, limit: int = 50) -> list[AiRescueQueueRecord]:
        safe_limit = max(1, min(int(limit), 200))
        with self._connect() as connection:
            rows = connection.execute(
                """
                select * from ai_rescue_queue
                order by
                    case status when 'processing' then 0 when 'retry' then 1 when 'waiting' then 2 else 3 end,
                    coalesce(next_attempt_at, created_at),
                    id
                limit ?
                """,
                (safe_limit,),
            ).fetchall()
        return [_ai_rescue_queue_from_row(row) for row in rows]

    def ai_rescue_queue_snapshot(self, *, now: str, upcoming_limit: int = 10) -> dict[str, Any]:
        with self._connect() as connection:
            current_row = connection.execute(
                "select * from ai_rescue_queue where status = 'processing' order by started_at, id limit 1"
            ).fetchone()
            upcoming_rows = connection.execute(
                """
                select * from ai_rescue_queue
                where status = 'waiting'
                   or (status = 'retry' and (next_attempt_at is null or next_attempt_at <= ?))
                order by coalesce(next_attempt_at, created_at), id
                limit ?
                """,
                (now, max(1, min(int(upcoming_limit), 50))),
            ).fetchall()
            count_rows = connection.execute(
                """
                select status, count(*) as total
                from ai_rescue_queue
                where status in ('waiting', 'processing', 'retry')
                group by status
                """
            ).fetchall()
        counts = {"waiting": 0, "processing": 0, "retry": 0}
        counts.update({str(row["status"]): int(row["total"]) for row in count_rows})
        return {
            "current": _ai_rescue_queue_from_row(current_row) if current_row else None,
            "upcoming": [_ai_rescue_queue_from_row(row) for row in upcoming_rows],
            "counts": counts,
        }

    def claim_next_ai_rescue_queue_item(self, *, now: str) -> AiRescueQueueRecord | None:
        with self._connect() as connection:
            connection.execute("begin immediate")
            row = connection.execute(
                """
                select * from ai_rescue_queue
                where status = 'waiting'
                   or (status = 'retry' and (next_attempt_at is null or next_attempt_at <= ?))
                order by coalesce(next_attempt_at, created_at), id
                limit 1
                """,
                (now,),
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                """
                update ai_rescue_queue
                set status = 'processing', started_at = ?, updated_at = ?, last_error = null
                where id = ?
                  and (status = 'waiting' or (status = 'retry' and (next_attempt_at is null or next_attempt_at <= ?)))
                """,
                (now, now, row["id"], now),
            )
            claimed = connection.execute("select * from ai_rescue_queue where id = ?", (row["id"],)).fetchone()
        return _ai_rescue_queue_from_row(claimed)

    def reap_stale_ai_rescue_processing(self, *, now: str, stale_after_seconds: int) -> int:
        now_dt = _parse_datetime(now)
        if now_dt is None:
            return 0
        cutoff = (now_dt - timedelta(seconds=max(1, int(stale_after_seconds)))).isoformat().replace("+00:00", "Z")
        with self._connect() as connection:
            cursor = connection.execute(
                """
                update ai_rescue_queue
                set status = 'retry', next_attempt_at = ?, last_error = 'stale-processing', updated_at = ?
                where status = 'processing'
                  and started_at is not null
                  and datetime(replace(replace(started_at, 'T', ' '), 'Z', ''))
                      <= datetime(replace(replace(?, 'T', ' '), 'Z', ''))
                """,
                (now, now, cutoff),
            )
        return int(cursor.rowcount)

    def schedule_ai_rescue_retry(
        self, queue_id: int, *, now: str, next_attempt_at: str, last_error: str
    ) -> AiRescueQueueRecord:
        with self._connect() as connection:
            connection.execute(
                """
                update ai_rescue_queue
                set status = 'retry', attempt_count = attempt_count + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
                where id = ?
                """,
                (next_attempt_at, last_error, now, queue_id),
            )
            row = connection.execute("select * from ai_rescue_queue where id = ?", (queue_id,)).fetchone()
        return _ai_rescue_queue_from_row(row)

    def reject_ai_rescue_queue_item(
        self,
        queue_id: int,
        *,
        now: str,
        source: str,
        reason: str,
        details_json: str | None = None,
        increment_attempt: bool = False,
    ) -> AiRescueQueueRecord:
        with self._connect() as connection:
            row = connection.execute("select * from ai_rescue_queue where id = ?", (queue_id,)).fetchone()
            if row is None:
                raise KeyError(queue_id)
            attempt_increment = 1 if increment_attempt else 0
            connection.execute(
                """
                update ai_rescue_queue
                set status = 'rejected', attempt_count = attempt_count + ?, next_attempt_at = null,
                    last_error = ?, completed_at = ?, updated_at = ?
                where id = ?
                """,
                (attempt_increment, reason, now, now, queue_id),
            )
            existing_rejection = connection.execute(
                """
                select id from ai_rescue_rejections
                where queue_id = ? and source = ? and reason = ? and target_country is null and candidate_id is null
                """,
                (queue_id, source, reason),
            ).fetchone()
            if existing_rejection is None:
                connection.execute(
                    """
                    insert into ai_rescue_rejections(queue_id, video_id, source, reason, details_json)
                    values (?, ?, ?, ?, ?)
                    """,
                    (queue_id, row["video_id"], source, reason, details_json),
                )
            updated = connection.execute("select * from ai_rescue_queue where id = ?", (queue_id,)).fetchone()
        return _ai_rescue_queue_from_row(updated)

    def store_ai_rescue_candidate(
        self,
        *,
        queue_id: int,
        video_id: str,
        target_country: str,
        score: int,
        summary_es: str,
        angle_es: str,
        risk: str,
        risks_json: str | None = None,
        evidence: list[dict[str, Any]] | None = None,
        raw_response_json: str | None = None,
    ) -> AiRescueCandidateRecord:
        target = normalize_country(target_country)
        with self._connect() as connection:
            existing = connection.execute(
                "select id from ai_rescue_candidates where queue_id = ? and target_country = ? order by id limit 1",
                (queue_id, target),
            ).fetchone()
            if existing is None:
                cursor = connection.execute(
                    """
                    insert into ai_rescue_candidates(
                        queue_id, video_id, target_country, status, score, summary_es, angle_es, risk,
                        risks_json, raw_response_json
                    ) values (?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?)
                    """,
                    (queue_id, video_id, target, score, summary_es, angle_es, risk, risks_json, raw_response_json),
                )
                candidate_id = int(cursor.lastrowid)
            else:
                candidate_id = int(existing["id"])
                connection.execute(
                    """
                    update ai_rescue_candidates
                    set status = 'candidate', score = ?, summary_es = ?, angle_es = ?, risk = ?,
                        risks_json = ?, raw_response_json = ?, updated_at = current_timestamp
                    where id = ?
                    """,
                    (score, summary_es, angle_es, risk, risks_json, raw_response_json, candidate_id),
                )
            connection.execute("delete from ai_rescue_evidence where candidate_id = ?", (candidate_id,))
            for item in evidence or []:
                connection.execute(
                    """
                    insert into ai_rescue_evidence(
                        candidate_id, start_ms, end_ms, text, translation_es, explanation_es
                    ) values (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        candidate_id,
                        int(item["start_ms"]),
                        int(item["end_ms"]),
                        str(item["text"]),
                        str(item["translation_es"]),
                        str(item["explanation_es"]),
                    ),
                )
            connection.execute(
                "update ai_rescue_queue set status = 'candidate', updated_at = current_timestamp where id = ?", (queue_id,)
            )
        candidate = self.get_ai_rescue_candidate(candidate_id)
        if candidate is None:
            raise KeyError(candidate_id)
        return candidate

    def get_ai_rescue_candidate(self, candidate_id: int) -> AiRescueCandidateRecord | None:
        with self._connect() as connection:
            row = connection.execute("select * from ai_rescue_candidates where id = ?", (candidate_id,)).fetchone()
            if row is None:
                return None
            evidence_rows = connection.execute(
                "select * from ai_rescue_evidence where candidate_id = ? order by start_ms, id", (candidate_id,)
            ).fetchall()
        return _ai_rescue_candidate_from_row(row, evidence_rows)

    def get_ai_rescue_queue_item(self, queue_id: int) -> AiRescueQueueRecord | None:
        with self._connect() as connection:
            row = connection.execute("select * from ai_rescue_queue where id = ?", (queue_id,)).fetchone()
        return _ai_rescue_queue_from_row(row) if row else None

    def list_ai_rescue_candidates(self, *, now: str | None = None) -> list[AiRescueCandidateRecord]:
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        dismissal_sql, dismissal_args = _active_dismissal_sql("dismissals", now=now)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                select ai_rescue_candidates.*
                from ai_rescue_candidates
                join videos on videos.video_id = ai_rescue_candidates.video_id
                where ai_rescue_candidates.status = 'candidate'
                  and {window_sql}
                  and not exists (
                    select 1
                    from card_context_dismissals dismissals
                    where dismissals.surface = 'ai-rescue-candidate'
                      and dismissals.target_context = ai_rescue_candidates.target_country
                      and (
                        dismissals.candidate_id = ai_rescue_candidates.id
                        or (dismissals.candidate_id is null and dismissals.video_id = ai_rescue_candidates.video_id)
                      )
                      and {dismissal_sql}
                  )
                order by score desc, ai_rescue_candidates.id
                """,
                (*window_args, *dismissal_args),
            ).fetchall()
            evidence_by_candidate = _ai_rescue_evidence_by_candidate(connection, [int(row["id"]) for row in rows])
        return [_ai_rescue_candidate_from_row(row, evidence_by_candidate.get(int(row["id"]), [])) for row in rows]

    def count_ai_rescue_candidates(self, *, now: str | None = None) -> int:
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        dismissal_sql, dismissal_args = _active_dismissal_sql("dismissals", now=now)
        with self._connect() as connection:
            row = connection.execute(
                f"""
                select count(*) as total
                from ai_rescue_candidates
                join videos on videos.video_id = ai_rescue_candidates.video_id
                where ai_rescue_candidates.status = 'candidate'
                  and {window_sql}
                  and not exists (
                    select 1
                    from card_context_dismissals dismissals
                    where dismissals.surface = 'ai-rescue-candidate'
                      and dismissals.target_context = ai_rescue_candidates.target_country
                      and (
                        dismissals.candidate_id = ai_rescue_candidates.id
                        or (dismissals.candidate_id is null and dismissals.video_id = ai_rescue_candidates.video_id)
                      )
                      and {dismissal_sql}
                  )
                """,
                (*window_args, *dismissal_args),
            ).fetchone()
        return int(row["total"] if row else 0)

    def store_ai_rescue_rejection(
        self,
        *,
        video_id: str,
        source: str,
        reason: str,
        queue_id: int | None = None,
        candidate_id: int | None = None,
        target_country: str | None = None,
        details_json: str | None = None,
    ) -> AiRescueRejectionRecord:
        with self._connect() as connection:
            row = connection.execute(
                """
                select * from ai_rescue_rejections
                where queue_id is ?
                  and source = ?
                  and reason = ?
                  and coalesce(target_country, '') = coalesce(?, '')
                  and coalesce(candidate_id, 0) = coalesce(?, 0)
                """,
                (queue_id, source, reason, _normalize_country_optional(target_country), candidate_id),
            ).fetchone()
            if row is not None:
                return _ai_rescue_rejection_from_row(row)
            cursor = connection.execute(
                """
                insert into ai_rescue_rejections(
                    queue_id, video_id, candidate_id, target_country, source, reason, details_json
                ) values (?, ?, ?, ?, ?, ?, ?)
                """,
                (queue_id, video_id, candidate_id, _normalize_country_optional(target_country), source, reason, details_json),
            )
            row = connection.execute("select * from ai_rescue_rejections where id = ?", (cursor.lastrowid,)).fetchone()
        return _ai_rescue_rejection_from_row(row)

    def list_ai_rescue_rejections(self, *, now: str | None = None) -> list[AiRescueRejectionRecord]:
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                select ai_rescue_rejections.*
                from ai_rescue_rejections
                join videos on videos.video_id = ai_rescue_rejections.video_id
                where {window_sql}
                order by ai_rescue_rejections.id
                """,
                window_args,
            ).fetchall()
        return [_ai_rescue_rejection_from_row(row) for row in rows]

    def count_ai_rescue_rejections(self, *, now: str | None = None) -> int:
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        with self._connect() as connection:
            row = connection.execute(
                f"""
                select count(*) as total
                from ai_rescue_rejections
                join videos on videos.video_id = ai_rescue_rejections.video_id
                where {window_sql}
                """,
                window_args,
            ).fetchone()
        return int(row["total"] if row else 0)

    def mark_ai_rescue_candidate_rejected(
        self, candidate_id: int, *, reviewer: str | None, reason: str, decided_at: str
    ) -> AiRescueDecisionRecord:
        return self._record_ai_rescue_decision(
            candidate_id, decision="rejected", reviewer=reviewer, reason=reason, decided_at=decided_at
        )

    def mark_ai_rescue_candidate_approved(
        self, candidate_id: int, *, reviewer: str | None, decided_at: str
    ) -> AiRescueDecisionRecord:
        return self._record_ai_rescue_decision(
            candidate_id, decision="approved", reviewer=reviewer, reason=None, decided_at=decided_at
        )

    def promote_ai_rescue_candidate(
        self, candidate_id: int, *, allowed_target_countries: list[str]
    ) -> TargetMatchRecord:
        candidate = self.get_ai_rescue_candidate(candidate_id)
        if candidate is None:
            raise KeyError(candidate_id)
        allowed = {normalize_country(country) for country in allowed_target_countries}
        if candidate.target_country not in allowed:
            raise ValueError("target_country_not_configured")
        queue_item = self.get_ai_rescue_queue_item(candidate.queue_id)
        if queue_item and queue_item.source_country == candidate.target_country:
            raise ValueError("target_country_matches_source")
        with self._connect() as connection:
            queue_priority = _target_queue_priority(
                connection, video_id=candidate.video_id, target_country=candidate.target_country
            )
            connection.execute(
                """
                update videos
                set lifecycle = 'enqueue_pending',
                    matched = 1,
                    match_reason = coalesce(match_reason, ?),
                    updated_at = current_timestamp
                where video_id = ?
                """,
                (candidate.summary_es, candidate.video_id),
            )
            connection.execute(
                """
                insert into video_target_matches(
                    video_id, target_country, status, title_match_reason, approval_source,
                    queue_priority_tier, queue_priority_rank
                )
                values (?, ?, 'aprobado', ?, 'ai_rescue', ?, ?)
                on conflict(video_id, target_country) do update set
                    status = excluded.status,
                    title_match_reason = coalesce(excluded.title_match_reason, video_target_matches.title_match_reason),
                    approval_source = excluded.approval_source,
                    queue_priority_tier = coalesce(excluded.queue_priority_tier, video_target_matches.queue_priority_tier),
                    queue_priority_rank = coalesce(excluded.queue_priority_rank, video_target_matches.queue_priority_rank),
                    updated_at = current_timestamp
                """,
                (
                    candidate.video_id,
                    candidate.target_country,
                    candidate.summary_es,
                    queue_priority["tier"],
                    queue_priority["rank"],
                ),
            )
            connection.execute(
                "update ai_rescue_candidates set status = 'approved', updated_at = current_timestamp where id = ?",
                (candidate_id,),
            )
            connection.execute(
                "update ai_rescue_queue set status = 'approved', updated_at = current_timestamp where id = ?",
                (candidate.queue_id,),
            )
            row = connection.execute(
                "select * from video_target_matches where video_id = ? and target_country = ?",
                (candidate.video_id, candidate.target_country),
            ).fetchone()
        match = _target_match_from_row(row)
        return match

    def record_enqueue_attempt(
        self,
        *,
        video_id: str,
        status: str,
        radar_job_id: str | None = None,
        next_attempt_at: str | None = None,
        last_error: str | None = None,
        queue_priority_tier: str | None = None,
        queue_priority_rank: int | None = None,
    ) -> EnqueueAttemptRecord:
        attempt_count = self._next_enqueue_attempt_count(video_id)
        with self._connect() as connection:
            cursor = connection.execute(
                """
                insert into enqueue_attempts(
                    video_id, status, radar_job_id, attempt_count, next_attempt_at, last_error,
                    queue_priority_tier, queue_priority_rank
                )
                values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (video_id, status, radar_job_id, attempt_count, next_attempt_at, last_error, queue_priority_tier, queue_priority_rank),
            )
            row = connection.execute("select * from enqueue_attempts where id = ?", (cursor.lastrowid,)).fetchone()
        return _enqueue_attempt_from_row(row)

    def update_enqueue_attempt_status_by_job(
        self,
        *,
        video_id: str,
        radar_job_id: str,
        status: str,
        last_error: str | None = None,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                update enqueue_attempts
                set status = ?, last_error = ?, updated_at = current_timestamp
                where video_id = ? and radar_job_id = ?
                  and id = (
                    select max(id) from enqueue_attempts where video_id = ? and radar_job_id = ?
                  )
                """,
                (status, last_error, video_id, radar_job_id, video_id, radar_job_id),
            )

    def list_enqueue_attempts(self, video_id: str) -> list[EnqueueAttemptRecord]:
        with self._connect() as connection:
            rows = connection.execute(
                "select * from enqueue_attempts where video_id = ? order by id", (video_id,)
            ).fetchall()
        return [_enqueue_attempt_from_row(row) for row in rows]

    def backfill_important_audit(self, *, mode: str, classification_version: str, limit: int = 1000) -> dict[str, int]:
        if mode not in {"dry-run", "apply"}:
            raise ValueError("mode must be dry-run or apply")
        safe_limit = max(1, min(int(limit), 1000))
        with self._connect() as connection:
            protected_args = (*tuple(PROTECTED_TARGET_STATUSES), *tuple(PROTECTED_BACKFILL_ENQUEUE_STATUSES))
            protected_rows = connection.execute(
                f"""
                select distinct videos.video_id
                from videos
                left join video_target_matches matches on matches.video_id = videos.video_id
                left join enqueue_attempts latest
                  on latest.video_id = videos.video_id
                 and latest.id = (select max(id) from enqueue_attempts where video_id = videos.video_id)
                where matches.status in ({','.join('?' for _ in PROTECTED_TARGET_STATUSES)})
                   or matches.radar_job_id is not null
                   or latest.status in ({','.join('?' for _ in PROTECTED_BACKFILL_ENQUEUE_STATUSES)})
                   or latest.radar_job_id is not null
                """,
                protected_args,
            ).fetchall()
            skipped_protected = len({str(row["video_id"]) for row in protected_rows})
            candidates = connection.execute(
                f"""
                select videos.video_id, videos.title, videos.live_status, channels.label, channels.country, channels.important,
                       channels.important_mode, channels.important_rules_json
                from videos
                join channels on channels.id = videos.channel_id
                left join rejected_videos rejected on rejected.video_id = videos.video_id
                left join enqueue_attempts latest
                  on latest.video_id = videos.video_id
                 and latest.id = (select max(id) from enqueue_attempts where video_id = videos.video_id)
                where (channels.important_mode is not null or channels.important = 1)
                  and (videos.lifecycle in ('ignored_seen', 'enqueue_pending') or rejected.reason = 'no_title_match')
                  and (videos.important_mode is null or videos.queue_priority_tier is null or videos.classification_version is null)
                  and not exists (
                    select 1 from video_target_matches protected
                    where protected.video_id = videos.video_id
                      and (protected.status in ({','.join('?' for _ in PROTECTED_TARGET_STATUSES)}) or protected.radar_job_id is not null)
                  )
                  and (latest.status is null or latest.status not in ({','.join('?' for _ in PROTECTED_BACKFILL_ENQUEUE_STATUSES)}))
                  and latest.radar_job_id is null
                order by videos.created_at, videos.video_id
                limit ?
                """,
                (*tuple(PROTECTED_TARGET_STATUSES), *tuple(PROTECTED_BACKFILL_ENQUEUE_STATUSES), safe_limit),
            ).fetchall()
            candidates = [row for row in candidates if _important_backfill_match(row) is not None]
            if mode == "dry-run":
                return {
                    "candidate_count": len(candidates),
                    "updated_videos": 0,
                    "updated_target_matches": 0,
                    "skipped_protected": skipped_protected,
                }
            updated_videos = 0
            for row in candidates:
                match = _important_backfill_match(row)
                if match is None:
                    continue
                cursor = connection.execute(
                    """
                    update videos
                    set lifecycle = 'enqueue_pending',
                        matched = 1,
                        important_mode = ?,
                        important_rule_json = coalesce(important_rule_json, ?),
                        classification_status = 'important',
                        classification_reason = ?,
                        queue_priority_tier = 'important',
                        queue_priority_rank = 0,
                        classification_version = coalesce(classification_version, ?),
                        updated_at = current_timestamp
                    where video_id = ?
                    """,
                    (match["important_mode"], match["rule_json"], match["reason"], classification_version, row["video_id"]),
                )
                updated_videos += int(cursor.rowcount)
        return {
            "candidate_count": len(candidates),
            "updated_videos": updated_videos,
            "updated_target_matches": 0,
            "skipped_protected": skipped_protected,
        }

    def list_monitor_cards(self, *, limit: int = 50, offset: int = 0, now: str | None = None) -> list[MonitorCardRecord]:
        safe_limit = max(1, min(int(limit), 1000))
        safe_offset = max(0, int(offset))
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        with self._connect() as connection:
            rows = connection.execute(
                """
                select
                    videos.video_id,
                    videos.title,
                    videos.published_at,
                    videos.lifecycle,
                    videos.matched,
                    channels.country,
                    channels.label as channel_label,
                    latest.status as enqueue_status,
                    latest.radar_job_id,
                    latest.attempt_count,
                    latest.last_error
                from videos
                left join channels on channels.id = videos.channel_id
                left join enqueue_attempts latest
                    on latest.video_id = videos.video_id
                   and latest.id = (
                        select max(id) from enqueue_attempts where video_id = videos.video_id
                   )
                where {window_sql}
                order by
                    coalesce(videos.published_at, videos.created_at) desc,
                    videos.created_at desc,
                    videos.video_id
                limit ? offset ?
                """.format(window_sql=window_sql),
                (*window_args, safe_limit, safe_offset),
            ).fetchall()
        return [_monitor_card_from_row(row) for row in rows]

    def list_target_cards(self, *, target_country: str | None = None, limit: int = 50, offset: int = 0, now: str | None = None) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 1000))
        safe_offset = max(0, int(offset))
        target = normalize_country(target_country) if target_country else None
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        dismissal_sql, dismissal_args = _active_dismissal_sql("dismissals", now=now)
        filters = [window_sql]
        args_list: list[Any] = list(window_args)
        filters.append(
            f"""
            not exists (
                select 1
                from card_context_dismissals dismissals
                where dismissals.surface = 'monitor-card'
                  and dismissals.target_context = matches.target_country
                  and dismissals.video_id = matches.video_id
                  and dismissals.candidate_id is null
                  and {dismissal_sql}
            )
            """
        )
        args_list.extend(dismissal_args)
        if target:
            filters.append("matches.target_country = ?")
            args_list.append(target)
        where = "where " + " and ".join(filters)
        args: tuple[Any, ...] = (*args_list, safe_limit, safe_offset)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                select
                    matches.id,
                    matches.video_id,
                    matches.target_country,
                    matches.status,
                    matches.radar_job_id,
                    matches.mention_counts_json,
                    matches.last_error,
                    matches.classification_version,
                    matches.approval_source,
                    videos.title,
                    videos.url,
                    videos.published_at,
                    videos.lifecycle,
                    channels.country as source_country,
                    channels.label as channel_label,
                    coalesce(
                        (select sum(cast(json_extract(value, '$.count') as integer))
                         from json_each(
                            case when json_valid(matches.mention_counts_json) then matches.mention_counts_json else '[]' end
                         )),
                        0
                    ) as mention_score
                from video_target_matches matches
                join videos on videos.video_id = matches.video_id
                left join channels on channels.id = videos.channel_id
                {where}
                order by
                    case matches.target_country
                        when 'ecuador' then 1
                        when 'colombia' then 2
                        when 'argentina' then 3
                        when 'uruguay' then 4
                        when 'paraguay' then 5
                        when 'mexico' then 6
                        else 99
                    end,
                    case when channels.algorithm_priority_rank is null then 1 else 0 end,
                    mention_score desc,
                    channels.algorithm_priority_rank asc,
                    coalesce(videos.published_at, videos.created_at) desc,
                    videos.video_id
                limit ?
                offset ?
                """,
                args,
            ).fetchall()
        return [dict(row) for row in rows]

    def list_important_cards(self, *, limit: int = 50, offset: int = 0, now: str | None = None) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit), 1000))
        safe_offset = max(0, int(offset))
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        dismissal_sql, dismissal_args = _active_dismissal_sql("dismissals", now=now)
        with self._connect() as connection:
            rows = connection.execute(
                """
                select
                    videos.video_id || ':important' as id,
                    videos.video_id,
                    'important' as target_country,
                    coalesce(latest.status, videos.lifecycle) as status,
                    coalesce(summary.radar_job_id, latest.radar_job_id) as radar_job_id,
                    coalesce(summary.mention_counts_json, '[]') as mention_counts_json,
                    latest.last_error,
                    videos.classification_version,
                    videos.classification_reason,
                    videos.important_mode,
                    videos.important_rule_json,
                    'important_channel' as approval_source,
                    videos.title,
                    videos.url,
                    videos.published_at,
                    videos.lifecycle,
                    channels.country as source_country,
                    channels.label as channel_label
                from videos
                join channels on channels.id = videos.channel_id
                left join enqueue_attempts latest
                  on latest.video_id = videos.video_id
                 and latest.id = (
                    select max(id) from enqueue_attempts where video_id = videos.video_id
                 )
                left join important_summary_mentions summary on summary.video_id = videos.video_id
                where (
                    channels.important = 1
                    or videos.important_mode is not null
                    or videos.queue_priority_tier = 'important'
                    or videos.classification_status in ('important', 'important_channel')
                )
                  and {window_sql}
                  and not exists (
                    select 1
                    from card_context_dismissals dismissals
                    where dismissals.surface = 'monitor-card'
                      and dismissals.target_context = 'important'
                      and dismissals.video_id = videos.video_id
                      and dismissals.candidate_id is null
                      and {dismissal_sql}
                  )
                order by coalesce(videos.published_at, videos.created_at) desc, videos.video_id
                limit ? offset ?
                """.format(window_sql=window_sql, dismissal_sql=dismissal_sql),
                (*window_args, *dismissal_args, safe_limit, safe_offset),
            ).fetchall()
        return [dict(row) for row in rows]

    def count_monitor_cards(self, *, now: str | None = None) -> int:
        window_sql, window_args = _active_window_sql("detected_at", now=now)
        with self._connect() as connection:
            return int(connection.execute(f"select count(*) as total from videos where {window_sql}", window_args).fetchone()["total"])

    def count_target_cards(self, *, target_country: str | None = None, now: str | None = None) -> int:
        target = normalize_country(target_country) if target_country else None
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        dismissal_sql, dismissal_args = _active_dismissal_sql("dismissals", now=now)
        filters = [window_sql]
        args = list(window_args)
        filters.append(
            f"""
            not exists (
                select 1
                from card_context_dismissals dismissals
                where dismissals.surface = 'monitor-card'
                  and dismissals.target_context = matches.target_country
                  and dismissals.video_id = matches.video_id
                  and dismissals.candidate_id is null
                  and {dismissal_sql}
            )
            """
        )
        args.extend(dismissal_args)
        if target:
            filters.append("matches.target_country = ?")
            args.append(target)
        with self._connect() as connection:
            return int(connection.execute(f"select count(*) as total from video_target_matches matches join videos on videos.video_id = matches.video_id where {' and '.join(filters)}", tuple(args)).fetchone()["total"])

    def count_important_cards(self, *, now: str | None = None) -> int:
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        dismissal_sql, dismissal_args = _active_dismissal_sql("dismissals", now=now)
        with self._connect() as connection:
            return int(connection.execute(f"""
                select count(*) as total
                from videos
                join channels on channels.id = videos.channel_id
                where (channels.important = 1 or videos.important_mode is not null or videos.queue_priority_tier = 'important' or videos.classification_status in ('important', 'important_channel'))
                  and {window_sql}
                  and not exists (
                    select 1
                    from card_context_dismissals dismissals
                    where dismissals.surface = 'monitor-card'
                      and dismissals.target_context = 'important'
                      and dismissals.video_id = videos.video_id
                      and dismissals.candidate_id is null
                      and {dismissal_sql}
                  )
            """, (*window_args, *dismissal_args)).fetchone()["total"])

    def list_stale_classification_candidates(
        self, *, classification_version: str, limit: int = 100
    ) -> list[ClassificationCandidateRecord]:
        safe_limit = max(1, min(int(limit), 1000))
        with self._connect() as connection:
            rows = connection.execute(
                """
                select videos.*, channels.country as source_country
                from videos
                left join channels on channels.id = videos.channel_id
                where videos.title is not null
                  and trim(videos.title) != ''
                  and (videos.live_status is null or videos.live_status not in ('live', 'upcoming'))
                  and (videos.classification_version is null or videos.classification_version != ?)
                order by coalesce(videos.published_at, videos.created_at), videos.video_id
                limit ?
                """,
                (classification_version, safe_limit),
            ).fetchall()
        return [ClassificationCandidateRecord(video=_video_from_row(row), source_country=row["source_country"]) for row in rows]

    def count_stale_classification_candidates(self, *, classification_version: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                """
                select count(*) as total
                from videos
                where title is not null
                  and trim(title) != ''
                  and (live_status is null or live_status not in ('live', 'upcoming'))
                  and (classification_version is null or classification_version != ?)
                """,
                (classification_version,),
            ).fetchone()
        return int(row["total"])

    def latest_classification_run(self) -> ClassificationRunRecord | None:
        with self._connect() as connection:
            row = connection.execute("select * from classification_runs order by id desc limit 1").fetchone()
        return _classification_run_from_row(row) if row else None

    def get_classification_run(self, run_id: int) -> ClassificationRunRecord:
        with self._connect() as connection:
            row = connection.execute("select * from classification_runs where id = ?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        return _classification_run_from_row(row)

    def create_classification_run(
        self,
        *,
        classification_version: str,
        mode: str,
        candidate_count: int,
        parameters_json: str | None = None,
        status: str = "running",
    ) -> ClassificationRunRecord:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                insert into classification_runs(classification_version, mode, status, candidate_count, parameters_json)
                values (?, ?, ?, ?, ?)
                """,
                (classification_version, mode, status, candidate_count, parameters_json),
            )
            row = connection.execute("select * from classification_runs where id = ?", (cursor.lastrowid,)).fetchone()
        return _classification_run_from_row(row)

    def finish_classification_run(
        self,
        run_id: int,
        *,
        status: str,
        would_create_matches: int,
        would_create_rejections: int,
        created_or_updated_matches: int,
        created_or_updated_rejections: int,
        skipped_in_flight: int,
        error: str | None = None,
        completed_at: str | None = None,
    ) -> ClassificationRunRecord:
        with self._connect() as connection:
            connection.execute(
                """
                update classification_runs
                set status = ?, completed_at = coalesce(?, current_timestamp),
                    would_create_matches = ?, would_create_rejections = ?,
                    created_or_updated_matches = ?, created_or_updated_rejections = ?,
                    skipped_in_flight = ?, error = ?
                where id = ?
                """,
                (
                    status,
                    completed_at,
                    would_create_matches,
                    would_create_rejections,
                    created_or_updated_matches,
                    created_or_updated_rejections,
                    skipped_in_flight,
                    error,
                    run_id,
                ),
            )
            row = connection.execute("select * from classification_runs where id = ?", (run_id,)).fetchone()
        return _classification_run_from_row(row)

    def apply_classification(
        self,
        *,
        video_id: str,
        source_country: str | None,
        target_countries: list[str],
        status: str,
        reason: str,
        match_reason_json: str | None,
        classification_version: str,
        classification_run_id: int,
        classified_at: str,
    ) -> dict[str, int]:
        existing_matches = self.list_target_matches(video_id=video_id)
        if any(match.status in PROTECTED_TARGET_STATUSES or match.radar_job_id for match in existing_matches):
            return {"created_or_updated_matches": 0, "created_or_updated_rejections": 0, "skipped_in_flight": 1}
        video = self.get_video(video_id)
        if video is not None:
            self.upsert_video(
                video.with_updates(
                    classification_version=classification_version,
                    classified_at=classified_at,
                    classification_status=status,
                    classification_reason=reason,
                    classification_run_id=classification_run_id,
                )
            )
        created_or_updated_matches = 0
        created_or_updated_rejections = 0
        if target_countries:
            for target_country in target_countries:
                self.upsert_target_match(
                    TargetMatchRecord(
                        video_id=video_id,
                        target_country=target_country,
                        status="aprobado",
                        title_match_reason=match_reason_json,
                        classification_version=classification_version,
                        classified_at=classified_at,
                        classification_run_id=classification_run_id,
                        approval_source="title_classifier",
                    )
                )
                created_or_updated_matches += 1
        else:
            self.upsert_rejected_video(
                video_id=video_id,
                source_country=source_country,
                reason=reason,
                match_reason_json=match_reason_json,
                classification_version=classification_version,
                classified_at=classified_at,
                classification_run_id=classification_run_id,
            )
            created_or_updated_rejections = 1
        return {
            "created_or_updated_matches": created_or_updated_matches,
            "created_or_updated_rejections": created_or_updated_rejections,
            "skipped_in_flight": 0,
        }

    def count_rejected_videos(self, *, now: str | None = None) -> int:
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        with self._connect() as connection:
            row = connection.execute(_REJECTED_COUNT_SELECT + f" where {window_sql}", window_args).fetchone()
        return int(row["total"])

    def target_status_counts(self, *, now: str | None = None) -> dict[str, dict[str, int]]:
        window_sql, window_args = _active_window_sql("videos.detected_at", now=now)
        dismissal_sql, dismissal_args = _active_dismissal_sql("dismissals", now=now)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                select video_target_matches.target_country, video_target_matches.status, count(*) as total
                from video_target_matches
                join videos on videos.video_id = video_target_matches.video_id
                where {window_sql}
                  and not exists (
                    select 1
                    from card_context_dismissals dismissals
                    where dismissals.surface = 'monitor-card'
                      and dismissals.target_context = video_target_matches.target_country
                      and dismissals.video_id = video_target_matches.video_id
                      and dismissals.candidate_id is null
                      and {dismissal_sql}
                  )
                group by target_country, status
                """,
                (*window_args, *dismissal_args),
            ).fetchall()
        counts = {country: {"aprobado": 0, "transcribiendo": 0, "transcrito": 0, "error": 0} for country in TARGET_COUNTRY_ORDER}
        for row in rows:
            country = str(row["target_country"])
            status = str(row["status"])
            if country in counts and status in counts[country]:
                counts[country][status] = int(row["total"])
        return counts

    def build_retention_dry_run_report(self, *, cutoff: str, limit: int = 200) -> RetentionDryRunReport:
        safe_limit = max(1, min(int(limit), 1000))
        with self._connect() as connection:
            rows = connection.execute(
                """
                select * from videos
                where datetime(replace(replace(detected_at, 'T', ' '), 'Z', ''))
                    <= datetime(replace(replace(?, 'T', ' '), 'Z', ''))
                order by datetime(replace(replace(detected_at, 'T', ' '), 'Z', '')), video_id
                limit ?
                """,
                (cutoff, safe_limit),
            ).fetchall()
            items = [self._retention_item_from_row(connection, row) for row in rows]
        return RetentionDryRunReport(mode="dry-run", cutoff=cutoff, items=items)

    def _retention_item_from_row(self, connection: sqlite3.Connection, row: sqlite3.Row) -> RetentionDryRunItem:
        video_id = str(row["video_id"])
        counts = _empty_retention_deletion_counts()
        counts["videos"] = 1
        scalar_tables = [
            "enqueue_attempts",
            "video_target_matches",
            "rejected_videos",
            "card_context_dismissals",
            "ai_rescue_queue",
            "ai_rescue_candidates",
            "ai_rescue_rejections",
        ]
        for table in scalar_tables:
            counts[table] = _count_by_video_id(connection, table, video_id)
        candidate_ids = [
            int(candidate["id"])
            for candidate in connection.execute("select id from ai_rescue_candidates where video_id = ?", (video_id,)).fetchall()
        ]
        if candidate_ids:
            placeholders = ",".join("?" for _ in candidate_ids)
            counts["ai_rescue_evidence"] = int(
                connection.execute(
                    f"select count(*) as total from ai_rescue_evidence where candidate_id in ({placeholders})",
                    tuple(candidate_ids),
                ).fetchone()["total"]
            )
            counts["ai_rescue_decisions"] = int(
                connection.execute(
                    f"select count(*) as total from ai_rescue_decisions where candidate_id in ({placeholders})",
                    tuple(candidate_ids),
                ).fetchone()["total"]
            )
        job_ids = _unique_non_empty(
            [
                *(attempt["radar_job_id"] for attempt in connection.execute("select radar_job_id from enqueue_attempts where video_id = ? order by id", (video_id,))),
                *(match["radar_job_id"] for match in connection.execute("select radar_job_id from video_target_matches where video_id = ? order by id", (video_id,))),
            ]
        )
        states = {
            "target_matches": [dict(match) for match in connection.execute("select id, target_country, status, radar_job_id from video_target_matches where video_id = ? order by id", (video_id,)).fetchall()],
            "rejected": [dict(rejected) for rejected in connection.execute("select id, reason, source_country from rejected_videos where video_id = ? order by id", (video_id,)).fetchall()],
            "ai_rescue_queue": [dict(queue) for queue in connection.execute("select id, status, source_country from ai_rescue_queue where video_id = ? order by id", (video_id,)).fetchall()],
            "ai_rescue_candidates": [dict(candidate) for candidate in connection.execute("select id, queue_id, target_country, status from ai_rescue_candidates where video_id = ? order by id", (video_id,)).fetchall()],
            "ai_rescue_rejections": [dict(rejection) for rejection in connection.execute("select id, queue_id, candidate_id, target_country, source, reason from ai_rescue_rejections where video_id = ? order by id", (video_id,)).fetchall()],
        }
        url = row["url"]
        return RetentionDryRunItem(
            video_id=video_id,
            url=url,
            detected_at=str(row["detected_at"]),
            lifecycle=str(row["lifecycle"]),
            states=states,
            transcript_refs={
                "radar_job_ids": job_ids,
                "urls": _unique_non_empty([url]),
                "video_ids": [video_id],
            },
            planned_deletions=counts,
        )

    def delete_detected_video_state(self, video_id: str) -> dict[str, int]:
        counts = _empty_retention_deletion_counts()
        with self._connect() as connection:
            candidate_ids = [
                int(row["id"])
                for row in connection.execute("select id from ai_rescue_candidates where video_id = ?", (video_id,)).fetchall()
            ]
            if candidate_ids:
                placeholders = ",".join("?" for _ in candidate_ids)
                counts["ai_rescue_decisions"] = _delete_by_ids(connection, "ai_rescue_decisions", "candidate_id", candidate_ids)
                counts["ai_rescue_evidence"] = _delete_by_ids(connection, "ai_rescue_evidence", "candidate_id", candidate_ids)
                counts["ai_rescue_rejections"] += int(
                    connection.execute(
                        f"delete from ai_rescue_rejections where candidate_id in ({placeholders})",
                        tuple(candidate_ids),
                    ).rowcount
                )
            counts["ai_rescue_rejections"] += int(
                connection.execute("delete from ai_rescue_rejections where video_id = ?", (video_id,)).rowcount
            )
            counts["ai_rescue_candidates"] = int(
                connection.execute("delete from ai_rescue_candidates where video_id = ?", (video_id,)).rowcount
            )
            counts["ai_rescue_queue"] = int(
                connection.execute("delete from ai_rescue_queue where video_id = ?", (video_id,)).rowcount
            )
            counts["rejected_videos"] = int(
                connection.execute("delete from rejected_videos where video_id = ?", (video_id,)).rowcount
            )
            counts["card_context_dismissals"] = int(
                connection.execute("delete from card_context_dismissals where video_id = ?", (video_id,)).rowcount
            )
            counts["video_target_matches"] = int(
                connection.execute("delete from video_target_matches where video_id = ?", (video_id,)).rowcount
            )
            counts["enqueue_attempts"] = int(
                connection.execute("delete from enqueue_attempts where video_id = ?", (video_id,)).rowcount
            )
            counts["videos"] = int(connection.execute("delete from videos where video_id = ?", (video_id,)).rowcount)
        return counts

    def record_cleanup_run(self, *, started_at: str, deleted_count: int, error: str | None = None) -> CleanupRunRecord:
        with self._connect() as connection:
            cursor = connection.execute(
                "insert into cleanup_runs(started_at, deleted_count, error) values (?, ?, ?)",
                (started_at, deleted_count, error),
            )
            row = connection.execute("select * from cleanup_runs where id = ?", (cursor.lastrowid,)).fetchone()
        return _cleanup_run_from_row(row)

    def list_cleanup_runs(self) -> list[CleanupRunRecord]:
        with self._connect() as connection:
            rows = connection.execute("select * from cleanup_runs order by id").fetchall()
        return [_cleanup_run_from_row(row) for row in rows]

    def record_subscription(
        self,
        *,
        channel_id: int,
        callback_url: str,
        lease_seconds: int | None = None,
        expires_at: str | None = None,
        last_renewed_at: str | None = None,
        status: str = "ready",
        last_error: str | None = None,
    ) -> SubscriptionRecord:
        with self._connect() as connection:
            connection.execute(
                """
                insert into subscriptions(
                    channel_id, callback_url, lease_seconds, expires_at, last_renewed_at, status, last_error
                )
                values (?, ?, ?, ?, ?, ?, ?)
                on conflict(channel_id) do update set
                    callback_url = excluded.callback_url,
                    lease_seconds = excluded.lease_seconds,
                    expires_at = excluded.expires_at,
                    last_renewed_at = excluded.last_renewed_at,
                    status = excluded.status,
                    last_error = excluded.last_error
                """,
                (channel_id, callback_url, lease_seconds, expires_at, last_renewed_at, status, last_error),
            )
            row = connection.execute("select * from subscriptions where channel_id = ?", (channel_id,)).fetchone()
        return _subscription_from_row(row)

    def subscription_preflight(self, *, now: str | None = None, renew_within_hours: int = 24) -> dict[str, Any]:
        now_dt = _parse_datetime(now) if now else datetime.now(UTC)
        expiring_before = now_dt + timedelta(hours=renew_within_hours)
        with self._connect() as connection:
            rows = connection.execute(
                """
                select
                    channels.id as channel_id,
                    channels.youtube_channel_id,
                    channels.label,
                    subscriptions.expires_at,
                    subscriptions.status,
                    subscriptions.last_error
                from channels
                left join subscriptions on subscriptions.channel_id = channels.id
                where channels.enabled = 1
                order by channels.id
                """
            ).fetchall()
        findings: list[dict[str, Any]] = []
        for row in rows:
            base = {
                "channel_id": int(row["channel_id"]),
                "youtube_channel_id": str(row["youtube_channel_id"]),
                "label": str(row["label"]),
            }
            if row["status"] is None:
                findings.append({"code": "subscription_missing", **base})
                continue
            if row["status"] == "failed":
                findings.append({"code": "subscription_failed", **base, "last_error": row["last_error"]})
                continue
            expires_at = _parse_datetime(row["expires_at"])
            if expires_at is None or expires_at <= expiring_before:
                findings.append({"code": "subscription_expiring", **base, "expires_at": row["expires_at"]})
        if any(finding["code"] in {"subscription_missing", "subscription_failed"} for finding in findings):
            status = "failed"
        elif findings:
            status = "degraded"
        else:
            status = "ready"
        return {"status": status, "renew_within_hours": renew_within_hours, "findings": findings}

    def cleanup_preflight(self) -> dict[str, Any]:
        return {"status": "ready", "retention": "120h / 5 days from detected_at", "last_run": self._last_cleanup_run_dict()}

    def catchup_preflight(self) -> dict[str, Any]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                select * from channels
                where enabled = 1
                order by id
                """
            ).fetchall()
        findings: list[dict[str, Any]] = []
        ready_count = 0
        for row in rows:
            uploads_playlist_id = str(row["uploads_playlist_id"] or "").strip()
            if uploads_playlist_id:
                ready_count += 1
                continue
            findings.append(
                {
                    "code": "catchup_upload_playlist_missing",
                    "channel_id": int(row["id"]),
                    "youtube_channel_id": str(row["youtube_channel_id"]),
                    "label": str(row["label"]),
                    "country": str(row["country"]),
                }
            )
        return {
            "status": "degraded" if findings else "ready",
            "ready_channel_count": ready_count,
            "findings": findings,
        }

    def force_video_created_at(self, video_id: str, created_at: str) -> None:
        with self._connect() as connection:
            connection.execute("update videos set created_at = ? where video_id = ?", (created_at, video_id))

    def preflight(self) -> dict[str, Any]:
        if not self.db_path.exists():
            return {"status": "failed", "tables": [], "error": "database_not_found"}
        with self._connect() as connection:
            existing = {
                row[0]
                for row in connection.execute(
                    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
                )
            }
        tables = [table for table in REQUIRED_TABLES if table in existing]
        missing = [table for table in REQUIRED_TABLES if table not in existing]
        return {"status": "failed" if missing else "ready", "tables": tables, "missing_tables": missing}

    def _record_ai_rescue_decision(
        self,
        candidate_id: int,
        *,
        decision: str,
        reviewer: str | None,
        reason: str | None,
        decided_at: str,
    ) -> AiRescueDecisionRecord:
        candidate = self.get_ai_rescue_candidate(candidate_id)
        if candidate is None:
            raise KeyError(candidate_id)
        with self._connect() as connection:
            cursor = connection.execute(
                """
                insert into ai_rescue_decisions(candidate_id, decision, reviewer, reason, decided_at)
                values (?, ?, ?, ?, ?)
                """,
                (candidate_id, decision, reviewer, reason, decided_at),
            )
            connection.execute(
                "update ai_rescue_candidates set status = ?, updated_at = current_timestamp where id = ?",
                (decision, candidate_id),
            )
            if decision == "rejected":
                connection.execute(
                    """
                    insert into ai_rescue_rejections(
                        queue_id, video_id, candidate_id, target_country, source, reason, details_json
                    ) values (?, ?, ?, ?, 'human', ?, ?)
                    """,
                    (candidate.queue_id, candidate.video_id, candidate.id, candidate.target_country, reason or "human-rejected", None),
                )
            row = connection.execute("select * from ai_rescue_decisions where id = ?", (cursor.lastrowid,)).fetchone()
        return _ai_rescue_decision_from_row(row)

    def _dismissal_expires_at(self, *, video_id: str | None) -> str | None:
        if not video_id:
            return None
        with self._connect() as connection:
            row = connection.execute("select detected_at from videos where video_id = ?", (video_id,)).fetchone()
        if row is None:
            return None
        detected_at = _parse_datetime(row["detected_at"])
        if detected_at is None:
            return None
        return (detected_at + timedelta(hours=120)).astimezone(UTC).isoformat().replace("+00:00", "Z")

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.execute("pragma busy_timeout = 5000")
        connection.row_factory = sqlite3.Row
        return connection

    def _next_enqueue_attempt_count(self, video_id: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "select coalesce(max(attempt_count), 0) + 1 as next_count from enqueue_attempts where video_id = ?",
                (video_id,),
            ).fetchone()
        return int(row["next_count"])

    def _last_cleanup_run_dict(self) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("select * from cleanup_runs order by id desc limit 1").fetchone()
        if not row:
            return None
        return {"started_at": row["started_at"], "deleted_count": row["deleted_count"], "error": row["error"]}

    def _ensure_subscription_columns(self, connection: sqlite3.Connection) -> None:
        existing = {row["name"] for row in connection.execute("pragma table_info(subscriptions)").fetchall()}
        if "status" not in existing:
            connection.execute("alter table subscriptions add column status text not null default 'ready'")
        if "last_error" not in existing:
            connection.execute("alter table subscriptions add column last_error text")

    def _ensure_channel_importance_columns(self, connection: sqlite3.Connection) -> None:
        self._add_missing_columns(
            connection,
            "channels",
            {
                "important": "integer not null default 0",
                "priority_tier": "text",
                "algorithm_priority_rank": "integer",
                "important_mode": "text",
                "important_rules_json": "text",
            },
        )

    def _ensure_classification_columns(self, connection: sqlite3.Connection) -> None:
        self._add_missing_columns(
            connection,
            "videos",
            {
                "classification_version": "text",
                "classified_at": "text",
                "classification_status": "text",
                "classification_reason": "text",
                "classification_run_id": "integer",
            },
        )

    def _ensure_important_audit_columns(self, connection: sqlite3.Connection) -> None:
        self._add_missing_columns(
            connection,
            "videos",
            {
                "important_mode": "text",
                "important_rule_json": "text",
                "queue_priority_tier": "text",
                "queue_priority_rank": "integer",
            },
        )
        self._add_missing_columns(
            connection,
            "video_target_matches",
            {
                "queue_priority_tier": "text",
                "queue_priority_rank": "integer",
            },
        )
        self._add_missing_columns(
            connection,
            "enqueue_attempts",
            {
                "queue_priority_tier": "text",
                "queue_priority_rank": "integer",
            },
        )

    def _ensure_retention_columns(self, connection: sqlite3.Connection) -> None:
        self._add_missing_columns(connection, "videos", {"detected_at": "text"})
        connection.execute("update videos set detected_at = created_at where detected_at is null or trim(detected_at) = ''")
        self._add_missing_columns(
            connection,
            "video_target_matches",
            {
                "classification_version": "text",
                "classified_at": "text",
                "classification_run_id": "integer",
                "approval_source": "text not null default 'title_classifier'",
            },
        )

    def _ensure_channel_checkpoint_columns(self, connection: sqlite3.Connection) -> None:
        self._add_missing_columns(
            connection,
            "channels",
            {
                "baseline_started_at": "text",
                "last_seen_published_at": "text",
                "last_catchup_error": "text",
                "last_catchup_at": "text",
            },
        )
        self._add_missing_columns(
            connection,
            "rejected_videos",
            {
                "classification_version": "text",
                "classified_at": "text",
                "classification_run_id": "integer",
            },
        )

    def _add_missing_columns(self, connection: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
        existing = {row["name"] for row in connection.execute(f"pragma table_info({table})").fetchall()}
        for name, definition in columns.items():
            if name not in existing:
                connection.execute(f"alter table {table} add column {name} {definition}")

    def _remember_channel_importance(self, record: ChannelRecord) -> None:
        self._channel_importance[record.youtube_channel_id.casefold()] = (record.important_mode, list(record.important_rules))

    def _with_channel_importance(self, record: ChannelRecord) -> ChannelRecord:
        important_mode, important_rules = self._channel_importance.get(record.youtube_channel_id.casefold(), (record.important_mode, record.important_rules))
        return ChannelRecord(
            id=record.id,
            country=record.country,
            label=record.label,
            source_url=record.source_url,
            youtube_channel_id=record.youtube_channel_id,
            uploads_playlist_id=record.uploads_playlist_id,
            enabled=record.enabled,
            important=record.important,
            important_mode=important_mode,
            important_rules=important_rules,
            priority_tier=record.priority_tier,
            algorithm_priority_rank=record.algorithm_priority_rank,
            baseline_started_at=record.baseline_started_at,
            last_seen_published_at=record.last_seen_published_at,
            last_catchup_error=record.last_catchup_error,
            last_catchup_at=record.last_catchup_at,
        )


def _channel_from_row(row: sqlite3.Row) -> ChannelRecord:
    important_rules = _json_loads_list(row["important_rules_json"] if "important_rules_json" in row.keys() else None)
    return ChannelRecord(
        id=int(row["id"]),
        country=str(row["country"]),
        label=str(row["label"]),
        source_url=row["source_url"],
        youtube_channel_id=str(row["youtube_channel_id"]),
        uploads_playlist_id=row["uploads_playlist_id"],
        enabled=bool(row["enabled"]),
        important=bool(row["important"]),
        important_mode=row["important_mode"] if "important_mode" in row.keys() else None,
        important_rules=important_rules,
        priority_tier=row["priority_tier"],
        algorithm_priority_rank=row["algorithm_priority_rank"],
        baseline_started_at=row["baseline_started_at"] if "baseline_started_at" in row.keys() else None,
        last_seen_published_at=row["last_seen_published_at"] if "last_seen_published_at" in row.keys() else None,
        last_catchup_error=row["last_catchup_error"] if "last_catchup_error" in row.keys() else None,
        last_catchup_at=row["last_catchup_at"] if "last_catchup_at" in row.keys() else None,
    )


def _video_from_row(row: sqlite3.Row) -> VideoRecord:
    return VideoRecord(
        video_id=str(row["video_id"]),
        channel_id=row["channel_id"],
        title=row["title"],
        url=row["url"],
        published_at=row["published_at"],
        live_status=row["live_status"],
        lifecycle=str(row["lifecycle"]),
        matched=_bool_from_db(row["matched"]),
        match_reason=row["match_reason"],
        evaluated_at=row["evaluated_at"],
        next_poll_at=row["next_poll_at"],
        classification_version=row["classification_version"],
        classified_at=row["classified_at"],
        classification_status=row["classification_status"],
        classification_reason=row["classification_reason"],
        classification_run_id=row["classification_run_id"],
        important_mode=row["important_mode"],
        important_rule_json=row["important_rule_json"],
        queue_priority_tier=row["queue_priority_tier"],
        queue_priority_rank=row["queue_priority_rank"],
        detected_at=row["detected_at"],
    )


def _enqueue_attempt_from_row(row: sqlite3.Row) -> EnqueueAttemptRecord:
    return EnqueueAttemptRecord(
        id=int(row["id"]),
        video_id=str(row["video_id"]),
        status=str(row["status"]),
        radar_job_id=row["radar_job_id"],
        attempt_count=int(row["attempt_count"]),
        next_attempt_at=row["next_attempt_at"],
        last_error=row["last_error"],
        queue_priority_tier=row["queue_priority_tier"],
        queue_priority_rank=row["queue_priority_rank"],
    )


def _target_match_from_row(row: sqlite3.Row) -> TargetMatchRecord:
    return TargetMatchRecord(
        id=int(row["id"]),
        video_id=str(row["video_id"]),
        target_country=str(row["target_country"]),
        status=str(row["status"]),
        title_match_reason=row["title_match_reason"],
        radar_job_id=row["radar_job_id"],
        mention_counts_json=row["mention_counts_json"],
        last_error=row["last_error"],
        classification_version=row["classification_version"],
        classified_at=row["classified_at"],
        classification_run_id=row["classification_run_id"],
        approval_source=row["approval_source"],
        queue_priority_tier=row["queue_priority_tier"],
        queue_priority_rank=row["queue_priority_rank"],
    )


_REJECTED_VIDEO_SELECT = """
select
    rejected_videos.id,
    rejected_videos.video_id,
    rejected_videos.source_country,
    rejected_videos.reason,
    rejected_videos.match_reason_json,
    rejected_videos.classification_version,
    rejected_videos.classified_at,
    rejected_videos.classification_run_id,
    videos.title,
    videos.url,
    videos.published_at,
    channels.label as channel_label
from rejected_videos
left join videos on videos.video_id = rejected_videos.video_id
left join channels on channels.id = videos.channel_id
"""

_REJECTED_COUNT_SELECT = """
select count(*) as total
from rejected_videos
left join videos on videos.video_id = rejected_videos.video_id
"""


def _active_window_sql(column: str, *, now: str | None = None, hours: int = 120) -> tuple[str, tuple[Any, ...]]:
    normalized = f"datetime(replace(replace({column}, 'T', ' '), 'Z', ''))"
    if now:
        return f"{normalized} >= datetime(replace(replace(?, 'T', ' '), 'Z', ''), ?)", (now, f"-{hours} hours")
    return f"{normalized} >= datetime('now', ?)", (f"-{hours} hours",)


def _active_dismissal_sql(alias: str = "dismissals", *, now: str | None = None) -> tuple[str, tuple[Any, ...]]:
    normalized = f"datetime(replace(replace({alias}.expires_at, 'T', ' '), 'Z', ''))"
    if now:
        return f"({alias}.expires_at is null or {normalized} > datetime(replace(replace(?, 'T', ' '), 'Z', '')))", (now,)
    return f"({alias}.expires_at is null or {normalized} > datetime('now'))", ()


def _normalize_dismissal_surface(value: Any) -> str:
    surface = str(value or "").strip().casefold()
    if surface not in {"monitor-card", "ai-rescue-candidate"}:
        raise ValueError("invalid_surface")
    return surface


def _normalize_dismissal_context(value: Any) -> str:
    normalized = normalize_country(value)
    if normalized in {"importantes", "important"}:
        return "important"
    if normalized not in set(TARGET_COUNTRY_ORDER):
        raise ValueError("invalid_target_context")
    return normalized


def _dismissal_context_key(
    *, surface: str, target_context: str, video_id: str | None = None, candidate_id: int | None = None
) -> str:
    subject = str(candidate_id) if candidate_id is not None else str(video_id or "")
    return f"{surface}:{target_context}:{subject}"


def _optional_stripped(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _rejected_video_from_row(row: sqlite3.Row) -> RejectedVideoRecord:
    return RejectedVideoRecord(
        id=int(row["id"]),
        video_id=str(row["video_id"]),
        source_country=row["source_country"],
        reason=str(row["reason"]),
        title=row["title"],
        url=row["url"],
        channel_label=row["channel_label"],
        published_at=row["published_at"],
        match_reason_json=row["match_reason_json"],
        classification_version=row["classification_version"],
        classified_at=row["classified_at"],
        classification_run_id=row["classification_run_id"],
    )


def _ai_rescue_queue_from_row(row: sqlite3.Row) -> AiRescueQueueRecord:
    return AiRescueQueueRecord(
        id=int(row["id"]),
        video_id=str(row["video_id"]),
        source_country=row["source_country"],
        status=str(row["status"]),
        attempt_count=int(row["attempt_count"]),
        next_attempt_at=row["next_attempt_at"],
        last_error=row["last_error"],
    )


def _ai_rescue_evidence_from_row(row: sqlite3.Row) -> AiRescueEvidenceRecord:
    return AiRescueEvidenceRecord(
        id=int(row["id"]),
        candidate_id=int(row["candidate_id"]),
        start_ms=int(row["start_ms"]),
        end_ms=int(row["end_ms"]),
        text=str(row["text"]),
        translation_es=str(row["translation_es"]),
        explanation_es=str(row["explanation_es"]),
    )


def _ai_rescue_candidate_from_row(
    row: sqlite3.Row, evidence_rows: list[sqlite3.Row]
) -> AiRescueCandidateRecord:
    return AiRescueCandidateRecord(
        id=int(row["id"]),
        queue_id=int(row["queue_id"]),
        video_id=str(row["video_id"]),
        target_country=str(row["target_country"]),
        status=str(row["status"]),
        score=int(row["score"]),
        summary_es=str(row["summary_es"]),
        angle_es=str(row["angle_es"]),
        risk=str(row["risk"]),
        risks_json=row["risks_json"],
        raw_response_json=row["raw_response_json"],
        evidence=[_ai_rescue_evidence_from_row(evidence) for evidence in evidence_rows],
    )


def _ai_rescue_decision_from_row(row: sqlite3.Row) -> AiRescueDecisionRecord:
    return AiRescueDecisionRecord(
        id=int(row["id"]),
        candidate_id=int(row["candidate_id"]),
        decision=str(row["decision"]),
        reviewer=row["reviewer"],
        reason=row["reason"],
        decided_at=str(row["decided_at"]),
    )


def _ai_rescue_rejection_from_row(row: sqlite3.Row) -> AiRescueRejectionRecord:
    return AiRescueRejectionRecord(
        id=int(row["id"]),
        queue_id=row["queue_id"],
        video_id=str(row["video_id"]),
        candidate_id=row["candidate_id"],
        target_country=row["target_country"],
        source=str(row["source"]),
        reason=str(row["reason"]),
        details_json=row["details_json"],
    )


def _ai_rescue_evidence_by_candidate(
    connection: sqlite3.Connection, candidate_ids: list[int]
) -> dict[int, list[sqlite3.Row]]:
    if not candidate_ids:
        return {}
    placeholders = ",".join("?" for _ in candidate_ids)
    rows = connection.execute(
        f"select * from ai_rescue_evidence where candidate_id in ({placeholders}) order by start_ms, id",
        tuple(candidate_ids),
    ).fetchall()
    grouped: dict[int, list[sqlite3.Row]] = {candidate_id: [] for candidate_id in candidate_ids}
    for row in rows:
        grouped.setdefault(int(row["candidate_id"]), []).append(row)
    return grouped


def _classification_run_from_row(row: sqlite3.Row) -> ClassificationRunRecord:
    return ClassificationRunRecord(
        id=int(row["id"]),
        classification_version=str(row["classification_version"]),
        mode=str(row["mode"]),
        status=str(row["status"]),
        started_at=str(row["started_at"]),
        completed_at=row["completed_at"],
        candidate_count=int(row["candidate_count"]),
        would_create_matches=int(row["would_create_matches"]),
        would_create_rejections=int(row["would_create_rejections"]),
        created_or_updated_matches=int(row["created_or_updated_matches"]),
        created_or_updated_rejections=int(row["created_or_updated_rejections"]),
        skipped_in_flight=int(row["skipped_in_flight"]),
        error=row["error"],
        parameters_json=row["parameters_json"],
    )


def _monitor_card_from_row(row: sqlite3.Row) -> MonitorCardRecord:
    return MonitorCardRecord(
        video_id=str(row["video_id"]),
        title=row["title"],
        country=row["country"],
        channel_label=row["channel_label"],
        published_at=row["published_at"],
        lifecycle=str(row["lifecycle"]),
        matched=_bool_from_db(row["matched"]),
        enqueue_status=row["enqueue_status"],
        radar_job_id=row["radar_job_id"],
        attempt_count=int(row["attempt_count"]) if row["attempt_count"] is not None else None,
        last_error=row["last_error"],
    )


def _summary_items_by_real_country(summary: dict[str, Any], *, exclude_country: str | None = None) -> dict[str, str]:
    excluded = normalize_country(exclude_country) if exclude_country else None
    grouped: dict[str, list[dict[str, Any]]] = {country: [] for country in TARGET_COUNTRY_ORDER}
    for raw_item in summary.get("items", []):
        if not isinstance(raw_item, dict):
            continue
        target_country = normalize_country(raw_item.get("country"))
        if target_country not in grouped:
            continue
        if excluded and target_country == excluded:
            continue
        try:
            count = int(raw_item.get("count", 0))
        except (TypeError, ValueError):
            count = 0
        if count <= 0:
            continue
        label = str(raw_item.get("label") or raw_item.get("country") or "").strip()
        if not label:
            continue
        item: dict[str, Any] = {"label": label, "count": count}
        timestamps = raw_item.get("timestamps")
        if timestamps:
            item["timestamps"] = timestamps
        grouped[target_country].append(item)
    return {
        country: json.dumps(items, ensure_ascii=False, separators=(",", ":"))
        for country, items in grouped.items()
        if items
    }


def _global_summary_mentions_json(summary: dict[str, Any]) -> str:
    items: list[dict[str, Any]] = []
    for raw_item in summary.get("items", []):
        if not isinstance(raw_item, dict):
            continue
        target_country = normalize_country(raw_item.get("country"))
        if target_country in {"important", "importantes"}:
            continue
        try:
            count = int(raw_item.get("count", 0))
        except (TypeError, ValueError):
            count = 0
        if count <= 0:
            continue
        label = str(raw_item.get("label") or raw_item.get("country") or "").strip()
        if not label:
            continue
        item: dict[str, Any] = {"label": label, "count": count}
        timestamps = raw_item.get("timestamps")
        if timestamps:
            item["timestamps"] = timestamps
        items.append(item)
    items.sort(key=lambda item: (-int(item["count"]), str(item["label"])))
    return json.dumps(items, ensure_ascii=False, separators=(",", ":"))


def _important_backfill_match(row: sqlite3.Row) -> dict[str, str] | None:
    mode = str(row["important_mode"] or "").strip()
    legacy_important = "important" in row.keys() and bool(row["important"])
    if mode == "full_channel" or (not mode and legacy_important):
        return {
            "important_mode": mode or "legacy_important_channel",
            "reason": "important_full_channel",
            "rule_json": _json_dumps_compact([{"type": "important_full_channel", "label": row["label"], "source_country": normalize_country(row["country"])}]),
        }
    if mode != "program_rules":
        return None
    content_type = "live" if str(row["live_status"] or "").strip().casefold() in {"live", "upcoming"} else "completed"
    for rule in _json_loads_list(row["important_rules_json"]):
        content_types = [str(item).strip().casefold() for item in _rule_value(rule, "content_types", []) or []]
        if content_types and content_type not in content_types:
            continue
        match = match_program_title(str(row["title"] or ""), _RuleAdapter(rule))
        if match is None:
            continue
        return {
            "important_mode": "program_rules",
            "reason": "important_program_rule",
            "rule_json": _json_dumps_compact([
                {
                    "type": "important_program_rule",
                    "label": row["label"],
                    "source_country": normalize_country(row["country"]),
                    "op": match.op,
                    "value": match.value,
                    "normalized_value": match.normalized_value,
                    "normalized_title": match.normalized_title,
                }
            ]),
        }
    return None


class _RuleAdapter:
    def __init__(self, raw: Any):
        self.op = _rule_value(raw, "op", "")
        self.value = _rule_value(raw, "value", "")
        self.content_types = _rule_value(raw, "content_types", [])


def _rule_value(raw: Any, key: str, default: Any) -> Any:
    if isinstance(raw, dict):
        return raw.get(key, default)
    return getattr(raw, key, default)


def _target_queue_priority(connection: sqlite3.Connection, *, video_id: str, target_country: str) -> dict[str, Any]:
    row = connection.execute(
        """
        select channels.algorithm_priority_rank
        from videos
        left join channels on channels.id = videos.channel_id
        where videos.video_id = ?
        """,
        (video_id,),
    ).fetchone()
    country_index = _country_priority_index(target_country)
    algorithm_rank = row["algorithm_priority_rank"] if row else None
    if algorithm_rank is not None:
        return {"tier": f"{target_country}:algorithm_priority", "rank": country_index * 2 + 1}
    return {"tier": f"{target_country}:normal", "rank": country_index * 2 + 2}


def _country_priority_index(target_country: str) -> int:
    try:
        return list(TARGET_COUNTRY_ORDER).index(target_country)
    except ValueError:
        return len(TARGET_COUNTRY_ORDER)


def _cleanup_run_from_row(row: sqlite3.Row) -> CleanupRunRecord:
    return CleanupRunRecord(
        id=int(row["id"]),
        started_at=str(row["started_at"]),
        deleted_count=int(row["deleted_count"]),
        error=row["error"],
    )


def _subscription_from_row(row: sqlite3.Row) -> SubscriptionRecord:
    return SubscriptionRecord(
        channel_id=int(row["channel_id"]),
        callback_url=str(row["callback_url"]),
        lease_seconds=row["lease_seconds"],
        expires_at=row["expires_at"],
        last_renewed_at=row["last_renewed_at"],
        status=str(row["status"]),
        last_error=row["last_error"],
    )


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _bool_to_db(value: bool | None) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


def _bool_from_db(value: int | None) -> bool | None:
    if value is None:
        return None
    return bool(value)


def _empty_retention_deletion_counts() -> dict[str, int]:
    return {
        "videos": 0,
        "enqueue_attempts": 0,
        "video_target_matches": 0,
        "rejected_videos": 0,
        "card_context_dismissals": 0,
        "ai_rescue_queue": 0,
        "ai_rescue_candidates": 0,
        "ai_rescue_evidence": 0,
        "ai_rescue_decisions": 0,
        "ai_rescue_rejections": 0,
        "transcript_artifacts": 0,
    }


def _count_by_video_id(connection: sqlite3.Connection, table: str, video_id: str) -> int:
    return int(connection.execute(f"select count(*) as total from {table} where video_id = ?", (video_id,)).fetchone()["total"])


def _delete_by_ids(connection: sqlite3.Connection, table: str, column: str, ids: list[int]) -> int:
    if not ids:
        return 0
    placeholders = ",".join("?" for _ in ids)
    return int(connection.execute(f"delete from {table} where {column} in ({placeholders})", tuple(ids)).rowcount)


def _unique_non_empty(values: list[Any]) -> list[str]:
    unique: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in unique:
            unique.append(text)
    return unique


def _normalize_country_optional(value: Any) -> str | None:
    if value is None:
        return None
    normalized = normalize_country(value)
    return normalized or None


def _plain_json_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _plain_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_json_value(item) for item in value]
    if hasattr(value, "__dict__"):
        return {key: _plain_json_value(item) for key, item in value.__dict__.items()}
    return value


def _json_dumps_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads_list(value: str | None) -> list[Any]:
    if not value:
        return []
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError:
        return []
    return loaded if isinstance(loaded, list) else []
