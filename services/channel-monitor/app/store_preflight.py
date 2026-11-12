from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .store_cards import CardStoreMixin
from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .store_row_mappers import *
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

class PreflightStoreMixin(CardStoreMixin):
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


