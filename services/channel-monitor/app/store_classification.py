from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .store_videos import VideoStoreMixin
from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .store_row_mappers import *
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

class ClassificationStoreMixin(VideoStoreMixin):
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


