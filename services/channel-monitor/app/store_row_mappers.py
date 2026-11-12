from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

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
    if surface != "monitor-card":
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




def _count_by_video_id(connection: sqlite3.Connection, table: str, video_id: str) -> int:
    return int(connection.execute(f"select count(*) as total from {table} where video_id = ?", (video_id,)).fetchone()["total"])


def _rows_for_video(connection: sqlite3.Connection, table: str, video_id: str) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute(f"select * from {table} where video_id = ?", (video_id,)).fetchall()]


def _transcript_job_ids_for_video(connection: sqlite3.Connection, video_id: str) -> list[str]:
    enqueue_jobs = [row["radar_job_id"] for row in connection.execute("select radar_job_id from enqueue_attempts where video_id = ?", (video_id,)).fetchall()]
    match_jobs = [row["radar_job_id"] for row in connection.execute("select radar_job_id from video_target_matches where video_id = ?", (video_id,)).fetchall()]
    return _unique_non_empty([*enqueue_jobs, *match_jobs])


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


__all__ = [name for name in globals() if not name.startswith('__')]
