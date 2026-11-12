from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .store_classification import ClassificationStoreMixin
from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .store_row_mappers import *
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

class CardStoreMixin(ClassificationStoreMixin):
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
                    videos.created_at,
                    videos.lifecycle,
                    channels.country as source_country,
                    channels.label as channel_label,
                    channels.algorithm_priority_rank as channel_priority_rank,
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
                        when 'aurenia' then 1
                        when 'montelia' then 2
                        when 'valdoria' then 3
                        when 'rivamar' then 4
                        when 'bosquemar' then 5
                        when 'terramar' then 6
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
                    videos.created_at,
                    videos.lifecycle,
                    channels.country as source_country,
                    channels.label as channel_label,
                    channels.algorithm_priority_rank as channel_priority_rank
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
        for table in ["enqueue_attempts", "video_target_matches", "rejected_videos", "card_context_dismissals"]:
            counts[table] = _count_by_video_id(connection, table, video_id)
        job_ids = _transcript_job_ids_for_video(connection, video_id)
        return RetentionDryRunItem(
            video_id=video_id,
            url=row["url"],
            detected_at=row["detected_at"],
            lifecycle=row["lifecycle"],
            states={
                "enqueue_attempts": _rows_for_video(connection, "enqueue_attempts", video_id),
                "video_target_matches": _rows_for_video(connection, "video_target_matches", video_id),
                "rejected_videos": _rows_for_video(connection, "rejected_videos", video_id),
                "card_context_dismissals": _rows_for_video(connection, "card_context_dismissals", video_id),
            },
            transcript_refs={"radar_job_ids": job_ids, "urls": [row["url"]] if row["url"] else [], "video_ids": [video_id]},
            planned_deletions=counts,
        )


    def delete_detected_video_state(self, video_id: str) -> dict[str, int]:
        counts = _empty_retention_deletion_counts()
        with self._connect() as connection:
            counts["card_context_dismissals"] = int(
                connection.execute("delete from card_context_dismissals where video_id = ?", (video_id,)).rowcount
            )
            counts["rejected_videos"] = int(
                connection.execute("delete from rejected_videos where video_id = ?", (video_id,)).rowcount
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


