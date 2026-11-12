from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .store_channels import ChannelStoreMixin
from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .store_row_mappers import *
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

class VideoStoreMixin(ChannelStoreMixin):
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
                    videos.queue_priority_tier = 'important'
                    or videos.important_mode is not null
                    or videos.classification_status in ('important', 'important_channel')
                    or channels.important = 1
                  )
                  and (
                    matches.status = 'aprobado'
                    or (
                      videos.matched = 1
                      and not exists (select 1 from video_target_matches where video_id = videos.video_id)
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
                        when 'aurenia' then 1
                        when 'montelia' then 2
                        when 'valdoria' then 3
                        when 'rivamar' then 4
                        when 'bosquemar' then 5
                        when 'terramar' then 6
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
                        when 'aurenia' then 1
                        when 'montelia' then 2
                        when 'valdoria' then 3
                        when 'rivamar' then 4
                        when 'bosquemar' then 5
                        when 'terramar' then 6
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
                        when 'aurenia' then 1
                        when 'montelia' then 2
                        when 'valdoria' then 3
                        when 'rivamar' then 4
                        when 'bosquemar' then 5
                        when 'terramar' then 6
                        else 99
                    end,
                    id
                """,
                (video_id,),
            ).fetchall()
        return [_target_match_from_row(row) for row in rows]


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


    def force_video_created_at(self, video_id: str, created_at: str) -> None:
        with self._connect() as connection:
            connection.execute("update videos set created_at = ? where video_id = ?", (created_at, video_id))


