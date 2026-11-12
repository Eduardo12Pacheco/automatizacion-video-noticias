from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .store_row_mappers import *
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

class MonitorStoreBase:
    def __init__(self, db_path: Path | str):
        self.db_path = Path(db_path)
        self._channel_importance: dict[str, tuple[str | None, list[Any]]] = {}


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


