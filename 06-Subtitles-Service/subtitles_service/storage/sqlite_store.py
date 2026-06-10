from __future__ import annotations

import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from subtitles_service.config.contracts import OUTPUT_DIR


class SubtitleStore:
    """SQLite-based storage for subtitle sessions, jobs, and snapshots."""

    def __init__(self, workspace_root: Path | None = None) -> None:
        self.workspace_root = workspace_root or OUTPUT_DIR.parent / "runtime-remote"
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        self.db_path = self.workspace_root / "subtitles.db"
        self._init_db()

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    source_language TEXT NOT NULL,
                    target_language TEXT NOT NULL DEFAULT 'es',
                    preview_video_path TEXT,
                    current_snapshot_version INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'created'
                );

                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    request_id TEXT,
                    progress_pct INTEGER NOT NULL DEFAULT 0,
                    artifact_path TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES sessions(id)
                );

                CREATE TABLE IF NOT EXISTS snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES sessions(id),
                    UNIQUE(session_id, version)
                );

                CREATE TABLE IF NOT EXISTS render_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    user_email TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    job_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES sessions(id),
                    UNIQUE(session_id, request_id)
                );
            """)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.db_path), isolation_level=None)

    def session_dir(self, session_id: str) -> Path:
        session_path = self.workspace_root / "sessions" / session_id
        session_path.mkdir(parents=True, exist_ok=True)
        return session_path

    def create_session(
        self,
        source_language: str,
        target_language: str = "es",
        preview_video_path: str | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        session_id = session_id or str(uuid4())
        now = datetime.now(timezone.utc).isoformat()

        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions (id, created_at, updated_at, source_language, target_language, preview_video_path)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, now, now, source_language, target_language, preview_video_path),
            )

        return self.get_session(session_id)

    def get_session(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            return dict(row) if row else None

    def list_sessions(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(row) for row in rows]

    def update_session(self, session_id: str, **fields: Any) -> dict[str, Any] | None:
        if not fields:
            return self.get_session(session_id)

        fields["updated_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in fields.keys())
        values = list(fields.values()) + [session_id]

        with self._connect() as conn:
            conn.execute(f"UPDATE sessions SET {set_clause} WHERE id = ?", values)

        return self.get_session(session_id)

    def create_job(
        self,
        session_id: str,
        kind: str,
        status: str,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        job_id = str(uuid4())
        now = datetime.now(timezone.utc).isoformat()

        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs (id, session_id, kind, status, request_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (job_id, session_id, kind, status, request_id, now, now),
            )

        return self.get_job(job_id)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            return dict(row) if row else None

    def update_job(
        self,
        job_id: str,
        status: str | None = None,
        progress_pct: int | None = None,
        artifact_path: str | None = None,
    ) -> dict[str, Any] | None:
        fields = {}
        if status is not None:
            fields["status"] = status
        if progress_pct is not None:
            fields["progress_pct"] = progress_pct
        if artifact_path is not None:
            fields["artifact_path"] = artifact_path

        if not fields:
            return self.get_job(job_id)

        fields["updated_at"] = datetime.now(timezone.utc).isoformat()
        set_clause = ", ".join(f"{k} = ?" for k in fields.keys())
        values = list(fields.values()) + [job_id]

        with self._connect() as conn:
            conn.execute(f"UPDATE jobs SET {set_clause} WHERE id = ?", values)

        return self.get_job(job_id)

    def save_snapshot(self, session_id: str, snapshot: dict[str, Any]) -> int:
        session = self.get_session(session_id)
        if not session:
            raise ValueError(f"Session not found: {session_id}")

        version = session["current_snapshot_version"] + 1
        now = datetime.now(timezone.utc).isoformat()

        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO snapshots (session_id, version, snapshot_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (session_id, version, json.dumps(snapshot), now),
            )
            conn.execute(
                "UPDATE sessions SET current_snapshot_version = ?, updated_at = ? WHERE id = ?",
                (version, now, session_id),
            )

        return version

    def get_latest_snapshot(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT * FROM snapshots
                WHERE session_id = ?
                ORDER BY version DESC
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()
            if row:
                result = dict(row)
                result["snapshot_json"] = json.loads(result["snapshot_json"])
                return result
            return None

    def remember_request(
        self,
        session_id: str,
        user_email: str,
        request_id: str,
        job_id: str,
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO render_requests (session_id, user_email, request_id, job_id, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, user_email, request_id, job_id, now),
            )

    def resolve_request(self, session_id: str, user_email: str, request_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT * FROM render_requests
                WHERE session_id = ? AND user_email = ? AND request_id = ?
                """,
                (session_id, user_email, request_id),
            ).fetchone()
            return dict(row) if row else None

    def finalize_render(self, session_id: str, job_id: str, artifact_path: str) -> None:
        self.update_job(job_id, status="succeeded", progress_pct=100, artifact_path=artifact_path)
        self.update_session(session_id, status="rendered")

    def get_latest_job_for_session(self, session_id: str, kind: str) -> dict[str, Any] | None:
        """Return the most recent job row of a given kind for the session.

        Used by the render + download endpoints to surface real status
        (running/queued/succeeded/failed) and the rendered artifact path
        without having to plumb a separate job lookup through the worker.
        """
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT * FROM jobs
                WHERE session_id = ? AND kind = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (session_id, kind),
            ).fetchone()
            return dict(row) if row else None

    def delete_session(self, session_id: str) -> bool:
        """Delete a session and everything tied to it.

        Returns True if a row was deleted, False if the session did not
        exist. Cleans up: jobs, render_requests, snapshots, and the
        session row itself. The on-disk session directory and video
        file are best-effort removed; missing files are not an error.
        """
        with self._connect() as conn:
            # Clean up dependent rows first to keep the schema happy even
            # without foreign-key cascade.
            conn.execute("DELETE FROM jobs WHERE session_id = ?", (session_id,))
            conn.execute(
                "DELETE FROM render_requests WHERE session_id = ?",
                (session_id,),
            )
            conn.execute("DELETE FROM snapshots WHERE session_id = ?", (session_id,))
            cursor = conn.execute(
                "DELETE FROM sessions WHERE id = ?", (session_id,)
            )
            deleted = cursor.rowcount > 0

        # Best-effort filesystem cleanup. We never want a half-deleted
        # session to leave a phantom file behind, so we swallow OSError
        # and let the boolean result reflect the database outcome.
        if deleted:
            session_dir = self.workspace_root / "sessions" / session_id
            if session_dir.exists():
                try:
                    shutil.rmtree(session_dir, ignore_errors=True)
                except OSError:
                    pass
        return deleted
