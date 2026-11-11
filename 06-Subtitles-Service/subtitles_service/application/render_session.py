from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from subtitles_service.domain.errors import ErrorCode, PipelineError
from subtitles_service.infrastructure.render.remotion import render_black_subtitles_video
from subtitles_service.storage.sqlite_store import SubtitleStore


def _default_render(
    session_dir: Path,
    source_video_path: Path,
    segments: list[dict[str, Any]],
) -> Path:
    """Default render function using Remotion."""
    return render_black_subtitles_video(session_dir, source_video_path, segments)


class RenderSessionService:
    """Service for rendering subtitle videos."""

    def __init__(
        self,
        store: SubtitleStore,
        render_video: Callable[[Path, Path, list[dict[str, Any]]], Path] | None = None,
    ) -> None:
        self.store = store
        self.render_video = render_video or _default_render

    def submit(
        self,
        session_id: str,
        base_version: int,
        user_email: str,
        request_id: str,
    ) -> dict[str, Any]:
        """Submit a render job for a session."""
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

        # Check version
        current_version = int(session.get("current_snapshot_version") or 0)
        if base_version != current_version:
            raise PipelineError(
                code=ErrorCode.SNAPSHOT_VERSION_CONFLICT,
                message="Snapshot version conflict",
                details={
                    "session_id": session_id,
                    "expected_version": current_version,
                    "received_version": base_version,
                },
            )

        # Get latest snapshot
        snapshot = self.store.get_latest_snapshot(session_id)
        if not snapshot:
            raise PipelineError(
                code=ErrorCode.RENDER_NOT_READY,
                message="No snapshot available for rendering",
                details={"session_id": session_id},
            )

        # Create job
        job = self.store.create_job(
            session_id=session_id,
            kind="render",
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

            # Render video
            session_dir = self.store.session_dir(session_id)
            source_video_path = Path(session.get("preview_video_path") or "")
            segments = snapshot.get("snapshot_json", {}).get("segments", [])

            final_path = self.render_video(
                session_dir=session_dir,
                source_video_path=source_video_path,
                segments=segments,
            )

            # Update job to succeeded
            self.store.update_job(
                job_id=str(job["id"]),
                status="succeeded",
                progress_pct=100,
                artifact_path=str(final_path),
            )

            # Finalize render
            self.store.finalize_render(
                session_id=session_id,
                job_id=str(job["id"]),
                artifact_path=str(final_path),
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
