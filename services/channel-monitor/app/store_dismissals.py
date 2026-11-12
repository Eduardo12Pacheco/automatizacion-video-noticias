from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .store_schema import SchemaStoreMixin
from .store_records import *
from .store_records import _empty_retention_deletion_counts
from .store_row_mappers import *
from .title_matcher import TARGET_COUNTRY_ORDER, match_program_title, normalize_country

class DismissalStoreMixin(SchemaStoreMixin):
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


