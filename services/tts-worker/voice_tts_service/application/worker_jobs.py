from __future__ import annotations

from pathlib import Path

from voice_tts_service.domain.presets import resolve_voice_profile
from voice_tts_service.infrastructure.runner import QueueFullError
from voice_tts_service.storage.worker_store import JobsDB


def enqueue_worker_job(db: JobsDB, runner, *, job_id: str, text: str, requested_by: str | None, voice_profile: str) -> str:
    resolved_profile = resolve_voice_profile(voice_profile)
    existing = db.get_job(job_id)
    if existing:
        return str(existing["status"])
    runner.enqueue(job_id=job_id, text=text, requested_by=requested_by, voice_profile=resolved_profile)
    return "queued"


def worker_job_detail(db: JobsDB, runner, job_id: str) -> dict | None:
    row = db.get_job(job_id)
    if not row:
        return None
    error = None
    if row.get("error_code") or row.get("error_message"):
        error = {"code": row.get("error_code"), "message": row.get("error_message")}
    return {
        "job_id": row["job_id"],
        "status": row["status"],
        "progress": {
            "stage": row.get("progress_stage") or row["status"],
            "percent": int(row.get("progress_percent") or 0),
            "position": runner.queue_position(job_id),
        },
        "created_at": row["created_at"],
        "started_at": row.get("started_at"),
        "finished_at": row.get("finished_at"),
        "error": error,
    }


def worker_artifact_path(db: JobsDB, job_id: str) -> tuple[str, Path | None]:
    row = db.get_job(job_id)
    if not row:
        return "missing", None
    if row["status"] != "done":
        return "not_ready", None
    wav = (row.get("output_wav_path") or "").strip()
    if not wav:
        return "expired", None
    wav_path = Path(wav)
    if not wav_path.exists():
        return "expired", None
    return "ready", wav_path
