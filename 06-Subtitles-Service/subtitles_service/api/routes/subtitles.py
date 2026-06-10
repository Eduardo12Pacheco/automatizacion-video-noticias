from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.responses import FileResponse

from subtitles_service.api.errors import http_error
from subtitles_service.application.analyze_session import AnalyzeSessionService
from subtitles_service.application.render_session import RenderSessionService
from subtitles_service.config.contracts import ALLOWED_INPUT_EXTENSIONS, MAX_VIDEO_INPUT_BYTES
from subtitles_service.domain.errors import ErrorCode, PipelineError
from subtitles_service.storage.sqlite_store import SubtitleStore


_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
_ALLOWED_SOURCE_LANGUAGES = {"auto", "en", "de"}


def _sanitize_source_language(raw: str | None) -> str:
    """Normalize the source language. Anything outside the allowed set becomes 'auto'."""
    value = (raw or "").strip().lower()
    if value in _ALLOWED_SOURCE_LANGUAGES:
        return value
    return "auto"


def _safe_filename(original: str) -> str:
    """Return a filesystem-safe version of an uploaded filename (no path components)."""
    base = os.path.basename((original or "").strip() or "source")
    sanitized = _SAFE_FILENAME_RE.sub("_", base).strip("._")
    if not sanitized:
        sanitized = "source"
    return sanitized[:120]


def _extension_for(filename: str) -> str:
    return os.path.splitext(filename)[1].lower()


def register_subtitle_routes(
    app: FastAPI,
    store: SubtitleStore,
    analyze_worker: AnalyzeSessionService,
    render_worker: RenderSessionService,
    require_auth: Callable,
) -> None:
    """Register all subtitle API routes."""

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/subtitles/sessions")
    async def create_session(
        video: UploadFile = File(...),
        source_language: str = Form("auto"),
        target_language: str = Form("es"),
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        # `require_auth` already raises an `HTTPException` (401) on bad auth.
        # We only need to convert `PipelineError` raised later in this handler.
        try:
            require_auth(x_api_key=x_api_key, authorization=authorization)
        except PipelineError as e:
            raise http_error(e) from e

        # --- Validate extension up-front (cheap, no body read) ---
        original_name = video.filename or ""
        ext = _extension_for(original_name)
        if ext not in ALLOWED_INPUT_EXTENSIONS:
            raise http_error(
                PipelineError(
                    code=ErrorCode.VIDEO_INPUT_CONTRACT_VIOLATION,
                    message="Unsupported video extension",
                    details={
                        "allowed_extensions": sorted(ALLOWED_INPUT_EXTENSIONS),
                        "received_extension": ext or None,
                    },
                )
            )

        # --- Pre-allocate session id so we know the storage dir before we open the file ---
        session_id = str(uuid.uuid4())
        session_dir = store.session_dir(session_id)
        safe_name = _safe_filename(original_name)
        target_path = session_dir / f"source{ext}"

        # --- Stream upload to disk, enforcing the size cap, and consume the body fully ---
        bytes_written = 0
        try:
            with target_path.open("wb") as out:
                while True:
                    chunk = await video.read(1024 * 1024)
                    if not chunk:
                        break
                    bytes_written += len(chunk)
                    if bytes_written > MAX_VIDEO_INPUT_BYTES:
                        # Close the file, remove the partial upload, and signal 413.
                        out.close()
                        try:
                            target_path.unlink(missing_ok=True)
                        except OSError:
                            pass
                        raise http_error(
                            PipelineError(
                                code=ErrorCode.VIDEO_INPUT_CONTRACT_VIOLATION,
                                message="Uploaded video exceeds maximum allowed size",
                                details={
                                    "max_bytes": MAX_VIDEO_INPUT_BYTES,
                                    "received_bytes": bytes_written,
                                },
                            )
                        )
                    out.write(chunk)
        finally:
            await video.close()

        # If the client never sent any bytes, treat as a contract violation.
        if bytes_written == 0:
            try:
                target_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise http_error(
                PipelineError(
                    code=ErrorCode.VIDEO_INPUT_CONTRACT_VIOLATION,
                    message="Uploaded video is empty",
                    details={"filename": safe_name},
                )
            )

        # --- Persist session with the file path so downstream renderers can find it ---
        normalized_source = _sanitize_source_language(source_language)
        normalized_target = (target_language or "es").strip().lower() or "es"

        session = store.create_session(
            session_id=session_id,
            source_language=normalized_source,
            target_language=normalized_target,
            preview_video_path=str(target_path),
        )

        # The frontend (`01-Control-Panel/.../controller/session.js`) reads
        # `response.session_id`, `response.status`, and `response.preview.video_url`.
        return {
            "session_id": session["id"],
            "status": session.get("status") or "created",
            "preview": {
                "video_url": f"/api/subtitles/sessions/{session['id']}/preview/video",
            },
            "session": session,
        }

    @app.get("/api/subtitles/sessions/{session_id}/preview/video")
    def get_preview_video(
        session_id: str,
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> FileResponse:
        try:
            require_auth(x_api_key=x_api_key, authorization=authorization)
        except PipelineError as e:
            raise http_error(e) from e

        session = store.get_session(session_id)
        if not session:
            raise http_error(
                PipelineError(
                    code=ErrorCode.SESSION_NOT_FOUND,
                    message=f"Session not found: {session_id}",
                    details={"session_id": session_id},
                )
            )

        preview_path_raw = session.get("preview_video_path")
        if not preview_path_raw:
            raise http_error(
                PipelineError(
                    code=ErrorCode.VIDEO_INPUT_CONTRACT_VIOLATION,
                    message="Session has no preview video",
                    details={"session_id": session_id},
                )
            )

        preview_path = Path(str(preview_path_raw))
        if not preview_path.is_file():
            raise http_error(
                PipelineError(
                    code=ErrorCode.ARTIFACT_VALIDATION_FAILED,
                    message="Preview video file is missing on disk",
                    details={"session_id": session_id, "path": str(preview_path)},
                )
            )

        media_type = "video/mp4" if preview_path.suffix.lower() == ".mp4" else "video/quicktime"
        return FileResponse(path=str(preview_path), media_type=media_type)

    @app.get("/api/subtitles/sessions")
    def list_sessions(
        limit: int = 20,
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        sessions = store.list_sessions(limit=limit)
        return {"sessions": sessions}

    @app.get("/api/subtitles/sessions/{session_id}")
    def get_session(
        session_id: str,
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        session = store.get_session(session_id)
        if not session:
            raise http_error(
                PipelineError(
                    code=ErrorCode.SESSION_NOT_FOUND,
                    message=f"Session not found: {session_id}",
                    details={"session_id": session_id},
                )
            )
        return {"session": session}

    @app.get("/api/subtitles/sessions/{session_id}/segments")
    def get_segments(
        session_id: str,
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        snapshot = store.get_latest_snapshot(session_id)
        if not snapshot:
            return {"segments": []}

        segments = snapshot.get("snapshot_json", {}).get("segments", [])
        return {"segments": segments}

    @app.put("/api/subtitles/sessions/{session_id}/segments")
    def update_segments(
        session_id: str,
        payload: dict[str, Any],
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        segments = payload.get("segments", [])
        snapshot = {"segments": segments}
        version = store.save_snapshot(session_id, snapshot)
        return {"version": version}

    @app.post("/api/subtitles/sessions/{session_id}/analyze")
    def start_analyze(
        session_id: str,
        payload: dict[str, Any],
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            user_email = require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        request_id = payload.get("request_id", "")
        base_version = payload.get("base_version", 0)

        job = analyze_worker.start_analysis(
            session_id=session_id,
            user_email=user_email,
            request_id=request_id,
        )
        return {"job": job}

    @app.post("/api/subtitles/sessions/{session_id}/render")
    def start_render(
        session_id: str,
        payload: dict[str, Any],
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            user_email = require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        request_id = payload.get("request_id", "")
        base_version = payload.get("base_version", 0)

        job = render_worker.submit(
            session_id=session_id,
            base_version=base_version,
            user_email=user_email,
            request_id=request_id,
        )
        return {"job": job}

    @app.get("/api/subtitles/sessions/{session_id}/render")
    def get_render_status(
        session_id: str,
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        # Get latest job for this session
        # TODO: Implement proper job lookup
        return {"status": "unknown"}

    @app.get("/api/subtitles/sessions/{session_id}/download")
    def get_download(
        session_id: str,
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        session = store.get_session(session_id)
        if not session:
            raise http_error(
                PipelineError(
                    code=ErrorCode.SESSION_NOT_FOUND,
                    message=f"Session not found: {session_id}",
                    details={"session_id": session_id},
                )
            )

        # TODO: Implement proper download logic
        return {"ready": False}

    @app.get("/api/subtitles/sessions/{session_id}/download/file")
    def download_file(
        session_id: str,
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> FileResponse:
        try:
            require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        # TODO: Implement proper file download
        raise http_error(
            PipelineError(
                code=ErrorCode.RENDER_NOT_READY,
                message="No render artifact available",
                details={"session_id": session_id},
            )
        )
