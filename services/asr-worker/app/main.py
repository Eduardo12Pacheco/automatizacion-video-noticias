from __future__ import annotations

import secrets
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

from .audio import FfmpegAudioExtractor
from .catalog import get_catalog_summary
from .downloader import YtDlpDownloader, validate_media_url
from .models import HealthResponse, HistoryResponse, JobCreateRequest, JobCreateResponse, TranscribeRequest, TranscribeResponse
from .preflight import PreflightChecker, collect_preflight_failures
from .settings import Settings, load_settings
from .store import JobStore, JobStoreError
from .transcriber import FasterWhisperTranscriber
from .worker import DependencyFailure, TranscriptWorker


def _error(code: str, message: str, status_code: int) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _authorize(settings: Settings, api_key: str | None) -> None:
    if not settings.api_key:
        raise _error("missing_api_key_config", "Transcript service API key is not configured", 500)
    if not api_key or not secrets.compare_digest(api_key, settings.api_key):
        raise _error("unauthorized", "Invalid or missing API key", 401)


def create_downloader(settings: Settings):
    return YtDlpDownloader(
        binary=settings.yt_dlp_binary,
        timeout_seconds=settings.subprocess_timeout_seconds,
        cookies_path=settings.yt_dlp_cookies_path,
        js_runtime=settings.yt_dlp_js_runtime,
        remote_components=settings.yt_dlp_remote_components,
        max_filesize=settings.yt_dlp_max_filesize,
        max_duration_seconds=settings.yt_dlp_max_duration_seconds,
        socket_timeout_seconds=settings.yt_dlp_socket_timeout_seconds,
        retries=settings.yt_dlp_retries,
        fragment_retries=settings.yt_dlp_fragment_retries,
        resolve_media_host=settings.media_url_dns_check,
    )


def create_app(
    *,
    settings: Settings | None = None,
    store: JobStore | None = None,
    worker: Any | None = None,
    preflight_checker: Any | None = None,
    transcriber: Any | None = None,
) -> FastAPI:
    settings = settings or load_settings()
    store = store or JobStore(settings.runtime_dir)
    store.cleanup_expired_job_artifacts(ttl_seconds=settings.cleanup_ttl_seconds)
    store.recover_orphaned_active_jobs()
    transcriber = transcriber or FasterWhisperTranscriber(settings=settings)
    worker = worker or TranscriptWorker(
        settings=settings,
        store=store,
        downloader=create_downloader(settings),
        audio_extractor=FfmpegAudioExtractor(binary=settings.ffmpeg_binary, timeout_seconds=settings.subprocess_timeout_seconds),
        transcriber=transcriber,
    )
    preflight_checker = preflight_checker or PreflightChecker(settings)
    app = FastAPI(title="transcript-service-radar", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["x-api-key", "content-type"],
    )

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        if (
            request.url.path.startswith("/api/radar/")
            and request.url.path != "/api/radar/live"
            and request.method != "OPTIONS"
        ):
            try:
                _authorize(settings, request.headers.get("x-api-key"))
            except HTTPException as exc:
                return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        return await call_next(request)

    @app.get("/api/radar/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/radar/health", response_model=HealthResponse)
    async def health() -> dict[str, Any]:
        runtime = preflight_checker.report()
        failures = collect_preflight_failures(runtime)
        return {
            "status": "degraded" if failures else "ok",
            "worker": {"busy": bool(getattr(worker, "busy", False)), "queue_depth": int(getattr(worker, "queue_depth", 0))},
            "runtime": {
                **runtime,
                "whisper_model": settings.whisper_model,
                "whisper_model_path": settings.whisper_model_path,
                "device": settings.device,
                "compute_type": settings.compute_type,
            },
            "failures": failures,
        }

    @app.post("/api/radar/jobs", status_code=201, response_model=JobCreateResponse)
    async def create_job(request: JobCreateRequest) -> JobCreateResponse:
        try:
            validate_media_url(request.url, resolve_host=settings.media_url_dns_check)
        except DependencyFailure as exc:
            raise _error(exc.code, exc.message, 422) from exc
        if not request.target and not request.countries:
            raise _error("missing_countries", "Select at least one country", 422)
        if bool(getattr(worker, "busy", False)) or store.has_active_job():
            raise _error("busy", "A radar job is already active", 409)
        job = store.create_job(
            url=request.url,
            target=request.target,
            countries=request.countries,
            extra_keywords=request.extra_keywords,
        )
        worker.enqueue(job.job_id)
        return JobCreateResponse(job_id=job.job_id, status=job.status)

    @app.post("/api/radar/transcribe", response_model=TranscribeResponse)
    async def transcribe_audio(request: TranscribeRequest) -> TranscribeResponse:
        audio_path = Path(request.audio_path)
        if audio_path.suffix.lower() not in {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".mp4", ".mkv", ".webm"}:
            raise _error("unsupported_audio_format", "Unsupported audio file extension", 422)
        if not audio_path.is_file():
            raise _error("audio_not_found", "Audio file was not found on the worker host", 404)
        try:
            segments, language = transcriber.transcribe(audio_path)
        except DependencyFailure as exc:
            status_code = 409 if exc.code == "gpu_busy" else 503
            raise _error(exc.code, exc.message, status_code) from exc
        return TranscribeResponse(
            segments=segments,
            language=language,
            device=getattr(transcriber, "device", None),
            fallback_used=bool(getattr(transcriber, "fallback_used", False)),
        )

    @app.get("/api/radar/catalog")
    async def catalog() -> dict[str, Any]:
        return get_catalog_summary()

    @app.get("/api/radar/jobs", response_model=HistoryResponse)
    async def history() -> HistoryResponse:
        return HistoryResponse(items=store.list_history())

    @app.get("/api/radar/jobs/{job_id}")
    async def detail(job_id: str) -> dict[str, Any]:
        try:
            return store.get_job(job_id).model_dump(mode="json")
        except JobStoreError as exc:
            raise _error(exc.code, exc.message, 400 if exc.code == "invalid_job_id" else 404) from exc

    @app.get("/api/radar/jobs/{job_id}/transcript")
    async def transcript(job_id: str) -> dict[str, Any]:
        try:
            return store.get_transcript(job_id).model_dump(mode="json")
        except JobStoreError as exc:
            raise _error(exc.code, exc.message, 400 if exc.code == "invalid_job_id" else 404) from exc

    @app.get("/api/radar/jobs/{job_id}/mentions")
    async def mentions(job_id: str) -> dict[str, Any]:
        try:
            return store.get_mentions(job_id).model_dump(mode="json")
        except JobStoreError as exc:
            raise _error(exc.code, exc.message, 400 if exc.code == "invalid_job_id" else 404) from exc

    @app.get("/api/radar/jobs/{job_id}/summary")
    async def summary(job_id: str) -> dict[str, Any]:
        try:
            return store.get_summary(job_id)
        except JobStoreError as exc:
            raise _error(exc.code, exc.message, 400 if exc.code == "invalid_job_id" else 404) from exc

    @app.get("/api/radar/jobs/{job_id}/export.txt")
    async def export_text(job_id: str) -> PlainTextResponse:
        try:
            return PlainTextResponse(store.get_export_text(job_id), media_type="text/plain; charset=utf-8")
        except JobStoreError as exc:
            raise _error(exc.code, exc.message, 400 if exc.code == "invalid_job_id" else 404) from exc

    @app.post("/api/radar/jobs/{job_id}/cancel")
    async def cancel(job_id: str) -> dict[str, Any]:
        try:
            return store.cancel_job(job_id).model_dump(mode="json")
        except JobStoreError as exc:
            raise _error(exc.code, exc.message, 400 if exc.code == "invalid_job_id" else 404) from exc

    @app.delete("/api/radar/jobs/{job_id}")
    async def delete(job_id: str) -> dict[str, str]:
        try:
            deleted = store.delete_job(job_id)
        except JobStoreError as exc:
            raise _error(exc.code, exc.message, 400 if exc.code == "invalid_job_id" else 404) from exc
        return {"job_id": job_id, "status": deleted.status.value}

    @app.post("/api/radar/cleanup/linked-artifacts")
    async def cleanup_linked_artifacts(request: dict[str, Any]) -> dict[str, Any]:
        try:
            return store.cleanup_linked_artifacts(
                job_ids=[str(value) for value in request.get("job_ids", [])],
                urls=[str(value) for value in request.get("urls", [])],
                video_ids=[str(value) for value in request.get("video_ids", [])],
                mode=str(request.get("mode", "dry-run")),
            )
        except ValueError as exc:
            raise _error("invalid_cleanup_mode", str(exc), 422) from exc

    return app


app = create_app()
