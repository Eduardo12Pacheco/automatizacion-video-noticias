from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .store_dismissals import DismissalStoreMixin
from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .store_row_mappers import *
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

class ChannelStoreMixin(DismissalStoreMixin):
    def upsert_channel(self, record: ChannelRecord) -> ChannelRecord:
        with self._connect() as connection:
            connection.execute(
                """
                insert into channels(
                    country, label, source_url, youtube_channel_id, uploads_playlist_id,
                    enabled, important, priority_tier, algorithm_priority_rank, important_mode, important_rules_json,
                    baseline_started_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    baseline_started_at = coalesce(excluded.baseline_started_at, channels.baseline_started_at),
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
                    record.baseline_started_at,
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
            for table in ["videos", "enqueue_attempts", "video_target_matches", "rejected_videos", "card_context_dismissals"]:
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
        uploads_playlist_id: str | None = None,
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
            uploads_playlist_id=(
                uploads_playlist_id if uploads_playlist_id is not None else existing.uploads_playlist_id
            ),
            enabled=enabled if enabled is not None else existing.enabled,
            important=existing.important,
            priority_tier=existing.priority_tier,
            algorithm_priority_rank=existing.algorithm_priority_rank,
            important_mode=existing.important_mode,
            important_rules=existing.important_rules,
        )
        return self.upsert_channel(updated)


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



