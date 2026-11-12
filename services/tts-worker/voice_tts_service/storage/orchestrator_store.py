from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class OrchestratorStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        return con

    def _init_db(self) -> None:
        with self._lock, self._connect() as con:
            con.execute("""
                CREATE TABLE IF NOT EXISTS idempotency_keys (
                  user_email TEXT NOT NULL,
                  request_id TEXT NOT NULL,
                  job_id TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  PRIMARY KEY (user_email, request_id)
                )
                """)
            con.execute("""
                CREATE TABLE IF NOT EXISTS request_audit (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_email TEXT,
                  action TEXT NOT NULL,
                  job_id TEXT,
                  meta_json TEXT,
                  created_at TEXT NOT NULL
                )
                """)
            con.execute("CREATE INDEX IF NOT EXISTS idx_audit_user_created ON request_audit(user_email, created_at)")
            con.commit()

    def get_job_for_request_id(self, user_email: str, request_id: str) -> str | None:
        with self._lock, self._connect() as con:
            row = con.execute(
                "SELECT job_id FROM idempotency_keys WHERE user_email=? AND request_id=?",
                (user_email, request_id),
            ).fetchone()
            return str(row["job_id"]) if row else None

    def save_request_mapping(self, user_email: str, request_id: str, job_id: str) -> None:
        with self._lock, self._connect() as con:
            con.execute(
                """
                INSERT OR IGNORE INTO idempotency_keys (user_email, request_id, job_id, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (user_email, request_id, job_id, utc_now()),
            )
            con.commit()

    def add_audit(self, user_email: str | None, action: str, job_id: str | None, meta_json: str | None) -> None:
        with self._lock, self._connect() as con:
            con.execute(
                "INSERT INTO request_audit (user_email, action, job_id, meta_json, created_at) VALUES (?, ?, ?, ?, ?)",
                (user_email, action, job_id, meta_json, utc_now()),
            )
            con.commit()
