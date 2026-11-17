from __future__ import annotations

import hashlib
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class JobsDB:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._lock = threading.Lock()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        return con

    def _init_db(self) -> None:
        with self._lock, self._connect() as con:
            con.execute("""
                CREATE TABLE IF NOT EXISTS jobs (
                  job_id TEXT PRIMARY KEY,
                  status TEXT NOT NULL,
                  voice_profile TEXT,
                  text_sha256 TEXT NOT NULL,
                  text_length INTEGER NOT NULL,
                  requested_by TEXT,
                  created_at TEXT NOT NULL,
                  started_at TEXT,
                  finished_at TEXT,
                  error_code TEXT,
                  error_message TEXT,
                  progress_stage TEXT,
                  progress_percent INTEGER,
                  output_wav_path TEXT,
                  output_report_path TEXT
                )
                """)
            columns = {row["name"] for row in con.execute("PRAGMA table_info(jobs)").fetchall()}
            if "voice_profile" not in columns:
                con.execute("ALTER TABLE jobs ADD COLUMN voice_profile TEXT")
            if "progress_percent" not in columns:
                con.execute("ALTER TABLE jobs ADD COLUMN progress_percent INTEGER")
            con.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at)")
            con.execute("CREATE INDEX IF NOT EXISTS idx_jobs_requested_by_created_at ON jobs(requested_by, created_at)")
            con.commit()

    def fail_incomplete_jobs_on_boot(self) -> None:
        with self._lock, self._connect() as con:
            con.execute("""
                UPDATE jobs
                SET status='error', error_code='WORKER_RESTART',
                    error_message='The worker restarted before finishing the job.', finished_at=?
                WHERE status IN ('queued','running')
                """, (utc_now(),))
            con.commit()

    def count_active(self) -> int:
        with self._lock, self._connect() as con:
            row = con.execute("SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued','running')").fetchone()
            return int(row["c"] if row else 0)

    def create_job(self, job_id: str, text: str, requested_by: str | None, voice_profile: str | None) -> None:
        text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        with self._lock, self._connect() as con:
            con.execute("""
                INSERT INTO jobs (
                  job_id, status, voice_profile, text_sha256, text_length, requested_by, created_at, progress_stage, progress_percent
                ) VALUES (?, 'queued', ?, ?, ?, ?, ?, 'queued', 0)
                """, (job_id, voice_profile, text_hash, len(text), requested_by, utc_now()))
            con.commit()

    def set_running(self, job_id: str) -> None:
        with self._lock, self._connect() as con:
            con.execute(
                "UPDATE jobs SET status='running', started_at=?, progress_stage='running', progress_percent=5 WHERE job_id=?",
                (utc_now(), job_id),
            )
            con.commit()

    def set_progress(self, job_id: str, stage: str, percent: int | None = None) -> None:
        if percent is None:
            sql = "UPDATE jobs SET progress_stage=? WHERE job_id=?"
            params = (stage, job_id)
        else:
            bounded = max(0, min(100, int(percent)))
            sql = "UPDATE jobs SET progress_stage=?, progress_percent=? WHERE job_id=?"
            params = (stage, bounded, job_id)
        with self._lock, self._connect() as con:
            con.execute(sql, params)
            con.commit()

    def set_done(self, job_id: str, output_wav_path: str, output_report_path: str) -> None:
        with self._lock, self._connect() as con:
            con.execute("""
                UPDATE jobs
                SET status='done', finished_at=?, progress_stage='done', progress_percent=100,
                    output_wav_path=?, output_report_path=?, error_code=NULL, error_message=NULL
                WHERE job_id=?
                """, (utc_now(), output_wav_path, output_report_path, job_id))
            con.commit()

    def set_error(self, job_id: str, error_code: str, error_message: str) -> None:
        with self._lock, self._connect() as con:
            con.execute("""
                UPDATE jobs
                SET status='error', finished_at=?, progress_stage='error',
                    progress_percent=CASE WHEN progress_percent IS NULL THEN 0 ELSE progress_percent END,
                    error_code=?, error_message=?
                WHERE job_id=?
                """, (utc_now(), error_code, error_message[:2000], job_id))
            con.commit()

    def get_job(self, job_id: str) -> dict | None:
        with self._lock, self._connect() as con:
            row = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            return dict(row) if row else None
