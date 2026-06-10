from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable

from subtitles_service.domain.errors import ErrorCode, PipelineError
from subtitles_service.domain.segments import normalize_segments_for_snapshot
from subtitles_service.storage.sqlite_store import SubtitleStore


class AnalyzeSessionService:
    """Service for analyzing subtitle sessions (transcription, translation, etc.).

    The actual ASR + translation work is delegated to a pipeline callable so
    tests can swap in a fake. By default we wire up the real
    ffmpeg -> faster-whisper -> opus-mt chain on the first call.

    Heavy work runs on a background thread so the upload handler returns
    quickly and the panel can poll the job's progress in the meantime.
    """

    def __init__(
        self,
        store: SubtitleStore,
        pipeline: Callable[[Path, str, str], list[dict[str, Any]]] | None = None,
    ) -> None:
        self.store = store
        self._pipeline_override = pipeline
        self._pipeline: Callable | None = None

    def _resolve_pipeline(self):
        if self._pipeline_override is not None:
            return self._pipeline_override
        if self._pipeline is None:
            from subtitles_service.application.pipelines.analysis import (
                run_real_analysis_pipeline,
            )
            self._pipeline = run_real_analysis_pipeline
        return self._pipeline

    def start_analysis(
        self,
        session_id: str,
        user_email: str,
        request_id: str,
    ) -> dict[str, Any]:
        """Kick the analyze pipeline for a session.

        Idempotent on `request_id`: if we've already processed the same
        (session, user_email, request_id) tuple, we return the previous
        job instead of starting a new one.
        """
        prior = self.store.resolve_request(
            session_id=session_id,
            user_email=user_email,
            request_id=request_id,
        )
        if prior and prior.get("job_id"):
            return self.store.get_job(str(prior["job_id"]))

        session = self.store.get_session(session_id)
        if not session:
            raise PipelineError(
                code=ErrorCode.SESSION_NOT_FOUND,
                message=f"Session not found: {session_id}",
                details={"session_id": session_id},
            )

        # Create the job eagerly so the panel has something to poll, then
        # dispatch the heavy work on a background thread.
        job = self.store.create_job(
            session_id=session_id,
            kind="analyze",
            status="queued",
            request_id=request_id,
        )

        thread = threading.Thread(
            target=self._run_pipeline_in_background,
            args=(session_id, user_email, request_id, str(job["id"]), session),
            daemon=True,
            name=f"analyze-{session_id[:8]}",
        )
        thread.start()
        return self.store.get_job(str(job["id"]))

    def _run_pipeline_in_background(
        self,
        session_id: str,
        user_email: str,
        request_id: str,
        job_id: str,
        session: dict[str, Any],
    ) -> None:
        """Worker body: ASR + translation, then snapshot.

        Any failure is recorded on the job and the session, but never
        propagates (this runs in a daemon thread).
        """
        try:
            self.store.update_job(job_id=job_id, status="running", progress_pct=5)
        except Exception:
            return

        try:
            source_video = session.get("preview_video_path")
            if not source_video or not Path(str(source_video)).is_file():
                raise PipelineError(
                    code=ErrorCode.VIDEO_INPUT_CONTRACT_VIOLATION,
                    message="Cannot analyze: no uploaded video on disk",
                    details={"session_id": session_id},
                )

            source_language = str(session.get("source_language") or "auto")
            target_language = str(session.get("target_language") or "es")

            pipeline = self._resolve_pipeline()
            raw_segments = pipeline(
                Path(str(source_video)),
                source_language,
                target_language,
                on_progress=lambda pct: self.store.update_job(
                    job_id=job_id, progress_pct=pct
                ),
            )

            normalized = normalize_segments_for_snapshot(raw_segments)

            self.store.update_job(job_id=job_id, progress_pct=92)

            snapshot = {
                "segments": normalized,
                "source_language": source_language,
                "target_language": target_language,
            }
            self.store.save_snapshot(session_id, snapshot)

            self.store.update_job(job_id=job_id, status="succeeded", progress_pct=100)
            self.store.update_session(session_id=session_id, status="analyzed")
            self.store.remember_request(
                session_id=session_id,
                user_email=user_email,
                request_id=request_id,
                job_id=job_id,
            )
        except PipelineError as error:
            self.store.update_job(job_id=job_id, status="failed", progress_pct=100)
            self.store.update_session(
                session_id=session_id,
                status="analyze_failed",
            )
        except Exception as error:  # noqa: BLE001
            self.store.update_job(job_id=job_id, status="failed", progress_pct=100)
            self.store.update_session(
                session_id=session_id,
                status="analyze_failed",
            )

    # ---- Synchronous helper for tests / explicit "run to completion" calls ----
    def run_analysis_blocking(
        self,
        session_id: str,
        user_email: str = "sync",
        request_id: str = "",
    ) -> dict[str, Any]:
        """Run the analyze pipeline synchronously and return the final job."""
        prior = self.store.resolve_request(
            session_id=session_id,
            user_email=user_email,
            request_id=request_id,
        )
        if prior and prior.get("job_id"):
            return self.store.get_job(str(prior["job_id"]))

        session = self.store.get_session(session_id)
        if not session:
            raise PipelineError(
                code=ErrorCode.SESSION_NOT_FOUND,
                message=f"Session not found: {session_id}",
                details={"session_id": session_id},
            )

        job = self.store.create_job(
            session_id=session_id,
            kind="analyze",
            status="queued",
            request_id=request_id,
        )

        try:
            self.store.update_job(job_id=str(job["id"]), status="running", progress_pct=5)
            source_video = session.get("preview_video_path")
            if not source_video or not Path(str(source_video)).is_file():
                raise PipelineError(
                    code=ErrorCode.VIDEO_INPUT_CONTRACT_VIOLATION,
                    message="Cannot analyze: no uploaded video on disk",
                    details={"session_id": session_id},
                )
            source_language = str(session.get("source_language") or "auto")
            target_language = str(session.get("target_language") or "es")
            pipeline = self._resolve_pipeline()
            raw_segments = pipeline(
                Path(str(source_video)),
                source_language,
                target_language,
                on_progress=lambda pct: self.store.update_job(
                    job_id=str(job["id"]), progress_pct=pct
                ),
            )
            normalized = normalize_segments_for_snapshot(raw_segments)
            self.store.update_job(job_id=str(job["id"]), progress_pct=92)
            snapshot = {
                "segments": normalized,
                "source_language": source_language,
                "target_language": target_language,
            }
            self.store.save_snapshot(session_id, snapshot)
            self.store.update_job(job_id=str(job["id"]), status="succeeded", progress_pct=100)
            self.store.update_session(session_id=session_id, status="analyzed")
            self.store.remember_request(
                session_id=session_id,
                user_email=user_email,
                request_id=request_id,
                job_id=str(job["id"]),
            )
            return self.store.get_job(str(job["id"]))
        except Exception:
            self.store.update_job(job_id=str(job["id"]), status="failed", progress_pct=100)
            self.store.update_session(
                session_id=session_id,
                status="analyze_failed",
            )
            raise
