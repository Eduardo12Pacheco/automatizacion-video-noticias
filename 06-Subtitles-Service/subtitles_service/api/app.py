from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Header, HTTPException

from subtitles_service.api.cors import (
    DEFAULT_CORS_ALLOW_ORIGIN_REGEX,
    add_cors_middleware,
)
from subtitles_service.api.errors import http_error
from subtitles_service.api.routes.subtitles import register_subtitle_routes
from subtitles_service.api.security import validate_voice_style_auth
from subtitles_service.application.analyze_session import AnalyzeSessionService
from subtitles_service.application.render_session import RenderSessionService
from subtitles_service.storage.sqlite_store import SubtitleStore


def _http_error(error: Exception) -> HTTPException:
    return http_error(error)


def create_app(
    workspace_root: Path,
    api_key: str,
    basic_user: str,
    basic_pass: str,
    allowed_origins: list[str] | None = None,
    allow_origin_regex: str | None = DEFAULT_CORS_ALLOW_ORIGIN_REGEX,
    store: SubtitleStore | None = None,
    analyze_worker: AnalyzeSessionService | None = None,
    render_worker: RenderSessionService | None = None,
) -> FastAPI:
    store = store or SubtitleStore(workspace_root=workspace_root)
    analyze_worker = analyze_worker or AnalyzeSessionService(store=store)
    render_worker = render_worker or RenderSessionService(store=store)
    app = FastAPI(title="Subtitulos 2 Remote API", version="0.1.0")
    add_cors_middleware(
        app=app,
        allowed_origins=allowed_origins,
        allow_origin_regex=allow_origin_regex,
    )

    def require_auth(
        x_api_key: str | None = Header(None),
        authorization: str | None = Header(None),
    ) -> str:
        try:
            return validate_voice_style_auth(
                x_api_key=x_api_key,
                authorization=authorization,
                api_key=api_key,
                basic_user=basic_user,
                basic_pass=basic_pass,
            )
        except Exception as error:
            raise _http_error(error) from error

    register_subtitle_routes(
        app=app,
        store=store,
        analyze_worker=analyze_worker,
        render_worker=render_worker,
        require_auth=require_auth,
    )
    return app
