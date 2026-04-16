from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import FileResponse

from config import WorkerConfig, load_config
from db import JobsDB
from runner import JobRunner, QueueFullError
from schemas import CreateJobRequest, JobDetailResponse, JobResponse


app = FastAPI(title="tts-worker", version="0.1.0")

cfg: WorkerConfig = load_config()
db = JobsDB(cfg.jobs_db)
runner = JobRunner(cfg=cfg, db=db)
ALLOWED_PRESETS = {'balanced_default', 'golazo_emotivo', 'golazo_informativo', 'default'}


def verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    if not cfg.internal_token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="TTS_WORKER_INTERNAL_TOKEN no está configurado.",
        )
    if x_internal_token != cfg.internal_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token interno inválido")


@app.on_event("startup")
def startup() -> None:
    cfg.runtime_dir.mkdir(parents=True, exist_ok=True)
    cfg.input_dir.mkdir(parents=True, exist_ok=True)
    cfg.output_dir.mkdir(parents=True, exist_ok=True)
    cfg.segments_dir.mkdir(parents=True, exist_ok=True)

    missing = [
        p for p in [cfg.ref_audio_path, cfg.ref_text_path, cfg.config_yaml_path, cfg.project_root / "src" / "main.py"] if not p.exists()
    ]
    if missing:
        missing_txt = "\n".join(str(x) for x in missing)
        raise RuntimeError(f"Faltan archivos obligatorios para worker:\n{missing_txt}")

    db.fail_incomplete_jobs_on_boot()
    runner.start()


@app.get("/internal/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "queue_max": cfg.queue_max,
        "job_timeout_sec": cfg.job_timeout_sec,
        "runtime_dir": str(cfg.runtime_dir),
    }


@app.post("/internal/jobs", response_model=JobResponse, status_code=202, dependencies=[Depends(verify_internal_token)])
def create_job(payload: CreateJobRequest) -> JobResponse:
    requested_profile = (payload.voice_profile or '').strip() or 'balanced_default'
    if requested_profile not in ALLOWED_PRESETS:
        raise HTTPException(status_code=400, detail='voice_profile inválido.')
    resolved_profile = 'balanced_default' if requested_profile == 'default' else requested_profile

    existing = db.get_job(payload.job_id)
    if existing:
        return JobResponse(job_id=payload.job_id, status=existing["status"])

    try:
        runner.enqueue(
            job_id=payload.job_id,
            text=payload.text,
            requested_by=payload.requested_by,
            voice_profile=resolved_profile,
        )
    except QueueFullError:
        raise HTTPException(status_code=429, detail="QUEUE_FULL")

    return JobResponse(job_id=payload.job_id, status="queued")


@app.get("/internal/jobs/{job_id}", response_model=JobDetailResponse, dependencies=[Depends(verify_internal_token)])
def get_job(job_id: str) -> JobDetailResponse:
    row = db.get_job(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="JOB_NOT_FOUND")

    error = None
    if row.get("error_code") or row.get("error_message"):
        error = {"code": row.get("error_code"), "message": row.get("error_message")}

    progress = {
        "stage": row.get("progress_stage") or row["status"],
        "percent": int(row.get("progress_percent") or 0),
        "position": runner.queue_position(job_id),
    }

    return JobDetailResponse(
        job_id=row["job_id"],
        status=row["status"],
        progress=progress,
        created_at=row["created_at"],
        started_at=row.get("started_at"),
        finished_at=row.get("finished_at"),
        error=error,
    )


@app.get("/internal/jobs/{job_id}/artifact", dependencies=[Depends(verify_internal_token)])
def download_artifact(job_id: str):
    row = db.get_job(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="JOB_NOT_FOUND")
    if row["status"] != "done":
        raise HTTPException(status_code=409, detail="JOB_NOT_READY")

    wav = (row.get("output_wav_path") or "").strip()
    if not wav:
        raise HTTPException(status_code=410, detail="ARTIFACT_EXPIRED")

    wav_path = Path(wav)
    if not wav_path.exists():
        raise HTTPException(status_code=410, detail="ARTIFACT_EXPIRED")

    return FileResponse(path=str(wav_path), media_type="audio/wav", filename=f"{job_id}.wav")
