from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import FileResponse

from voice_tts_service.api.schemas import CreateJobRequest, JobDetailResponse, JobResponse
from voice_tts_service.application.worker_jobs import enqueue_worker_job, worker_artifact_path, worker_job_detail
from voice_tts_service.config.worker import WorkerConfig, load_config
from voice_tts_service.domain.errors import QueueFullError
from voice_tts_service.infrastructure.runner import JobRunner
from voice_tts_service.storage.runtime_paths import ensure_worker_runtime_dirs
from voice_tts_service.storage.worker_store import JobsDB


def create_app(*, cfg: WorkerConfig | None = None, db: JobsDB | None = None, runner=None) -> FastAPI:
    cfg = cfg or load_config()
    db = db or JobsDB(cfg.jobs_db)
    runner = runner or JobRunner(cfg=cfg, db=db)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        ensure_worker_runtime_dirs(cfg.runtime_dir, cfg.input_dir, cfg.output_dir, cfg.segments_dir)
        missing = [p for p in [cfg.ref_audio_path, cfg.ref_text_path, cfg.config_yaml_path, cfg.project_root / "src" / "main.py"] if not p.exists()]
        if missing:
            raise RuntimeError("Faltan archivos obligatorios para worker:\n" + "\n".join(str(x) for x in missing))
        db.fail_incomplete_jobs_on_boot()
        runner.start()
        yield

    app = FastAPI(title="tts-worker", version="0.1.0", lifespan=lifespan)

    def verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
        if not cfg.internal_token:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="TTS_WORKER_INTERNAL_TOKEN no está configurado.")
        if x_internal_token != cfg.internal_token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token interno inválido")

    @app.get("/internal/healthz")
    def healthz() -> dict:
        return {"ok": True, "queue_max": cfg.queue_max, "job_timeout_sec": cfg.job_timeout_sec, "runtime_dir": str(cfg.runtime_dir)}

    @app.post("/internal/jobs", response_model=JobResponse, status_code=202, dependencies=[Depends(verify_internal_token)])
    def create_job(payload: CreateJobRequest) -> JobResponse:
        try:
            job_status = enqueue_worker_job(db, runner, job_id=payload.job_id, text=payload.text, requested_by=payload.requested_by, voice_profile=payload.voice_profile)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except QueueFullError as exc:
            raise HTTPException(status_code=429, detail="QUEUE_FULL") from exc
        return JobResponse(job_id=payload.job_id, status=job_status)

    @app.get("/internal/jobs/{job_id}", response_model=JobDetailResponse, dependencies=[Depends(verify_internal_token)])
    def get_job(job_id: str) -> JobDetailResponse:
        detail = worker_job_detail(db, runner, job_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="JOB_NOT_FOUND")
        return JobDetailResponse(**detail)

    @app.get("/internal/jobs/{job_id}/artifact", dependencies=[Depends(verify_internal_token)])
    def download_artifact(job_id: str):
        state, wav_path = worker_artifact_path(db, job_id)
        if state == "missing":
            raise HTTPException(status_code=404, detail="JOB_NOT_FOUND")
        if state == "not_ready":
            raise HTTPException(status_code=409, detail="JOB_NOT_READY")
        if state == "expired" or wav_path is None:
            raise HTTPException(status_code=410, detail="ARTIFACT_EXPIRED")
        return FileResponse(path=str(wav_path), media_type="audio/wav", filename=f"{job_id}.wav")

    return app


app = create_app()
