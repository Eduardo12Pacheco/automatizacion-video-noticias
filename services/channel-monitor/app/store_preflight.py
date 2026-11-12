from __future__ import annotations

import json
import sqlite3
from typing import Any

from .store_cards import CardStoreMixin
from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .store_row_mappers import *
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

class PreflightStoreMixin(CardStoreMixin):
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


