from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .store_base import MonitorStoreBase
from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .store_row_mappers import *
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

class SchemaStoreMixin(MonitorStoreBase):
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

                create table if not exists card_context_dismissals (
                    id integer primary key autoincrement,
                    surface text not null,
                    target_context text not null,
                    video_id text references videos(video_id),
                    candidate_id integer,
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


