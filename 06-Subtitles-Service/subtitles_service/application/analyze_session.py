from __future__ import annotations

from pathlib import Path
from typing import Any

from subtitles_service.domain.errors import ErrorCode, PipelineError
from subtitles_service.domain.segments import normalize_segments_for_snapshot
from subtitles_service.storage.sqlite_store import SubtitleStore


class AnalyzeSessionService:
    """Service for analyzing subtitle sessions (transcription, translation, etc.)."""

    def __init__(self, store: SubtitleStore) -> None:
        self.store = store

    def start_analysis(
        self,
        session_id: str,
        user_email: str,
        request_id: str,
    ) -> dict[str, Any]:
        """Start analysis pipeline for a session."""
        # Check if request was already processed
        prior = self.store.resolve_request(
            session_id=session_id,
            user_email=user_email,
            request_id=request_id,
        )
        if prior and prior.get("job_id"):
            return self.store.get_job(str(prior["job_id"]))

        # Get session
        session = self.store.get_session(session_id)
        if not session:
            raise PipelineError(
                code=ErrorCode.SESSION_NOT_FOUND,
                message=f"Session not found: {session_id}",
                details={"session_id": session_id},
            )

        # Create job
        job = self.store.create_job(
            session_id=session_id,
            kind="analyze",
            status="queued",
            request_id=request_id,
        )

        try:
            # Update job to running
            self.store.update_job(
                job_id=str(job["id"]),
                status="running",
                progress_pct=50,
            )

            # TODO: Implement actual analysis pipeline
            # This would include:
            # 1. Extract audio from video
            # 2. Transcribe audio (ASR)
            # 3. Translate transcription
            # 4. Create snapshot with segments

            # For now, create a placeholder snapshot
            session_dir = self.store.session_dir(session_id)
            segments = self._run_placeholder_analysis(session_dir, session)

            # Save snapshot
            snapshot = {
                "segments": segments,
                "source_language": session.get("source_language", "auto"),
                "target_language": session.get("target_language", "es"),
            }
            version = self.store.save_snapshot(session_id, snapshot)

            # Update job to succeeded
            self.store.update_job(
                job_id=str(job["id"]),
                status="succeeded",
                progress_pct=100,
            )

            # Update session status
            self.store.update_session(
                session_id=session_id,
                status="analyzed",
            )

            # Remember request
            self.store.remember_request(
                session_id=session_id,
                user_email=user_email,
                request_id=request_id,
                job_id=str(job["id"]),
            )

            # Return updated job
            return self.store.get_job(str(job["id"]))

        except Exception:
            # Update job to failed
            self.store.update_job(
                job_id=str(job["id"]),
                status="failed",
                progress_pct=100,
            )
            raise

    def _run_placeholder_analysis(
        self,
        session_dir: Path,
        session: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Placeholder analysis - returns empty segments."""
        # TODO: Implement actual ASR + translation pipeline
        return []
