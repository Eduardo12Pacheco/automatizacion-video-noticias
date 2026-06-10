from __future__ import annotations

from typing import Any, Callable

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse

from subtitles_service.api.errors import http_error
from subtitles_service.application.analyze_session import AnalyzeSessionService
from subtitles_service.application.render_session import RenderSessionService
from subtitles_service.domain.errors import ErrorCode, PipelineError
from subtitles_service.storage.sqlite_store import SubtitleStore


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
    def create_session(
        video: Any = None,
        source_language: str = "auto",
        target_language: str = "es",
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            user_email = require_auth(x_api_key=x_api_key, authorization=authorization)
        except Exception as e:
            raise http_error(e) from e

        # TODO: Handle video upload
        session = store.create_session(
            source_language=source_language,
            target_language=target_language,
        )
        return {"session": session}

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
