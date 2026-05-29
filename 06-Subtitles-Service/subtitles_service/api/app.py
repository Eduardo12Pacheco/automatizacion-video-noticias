from __future__ import annotations

import importlib.abc
import importlib.machinery
import importlib.util
import sys
from pathlib import Path


class _ProjectPycacheFinder(importlib.abc.MetaPathFinder):
    def __init__(self, project_root: Path) -> None:
        self.project_root = project_root
        self.cache_tag = sys.implementation.cache_tag

    def find_spec(self, fullname: str, path: object = None, target: object = None):
        if not fullname.startswith("subtitles_service."):
            return None

        parts = fullname.split(".")
        module_dir = self.project_root.joinpath(*parts[:-1])
        module_name = parts[-1]
        source_path = module_dir / f"{module_name}.py"
        package_source_path = module_dir / module_name / "__init__.py"
        if source_path.exists() or package_source_path.exists():
            return None

        pyc_path = module_dir / "__pycache__" / f"{module_name}.{self.cache_tag}.pyc"
        if not pyc_path.exists():
            return None

        loader = importlib.machinery.SourcelessFileLoader(fullname, str(pyc_path))
        return importlib.util.spec_from_file_location(fullname, str(pyc_path), loader=loader)


def _install_project_pycache_finder() -> None:
    project_root = Path(__file__).resolve().parents[2]
    for finder in sys.meta_path:
        if isinstance(finder, _ProjectPycacheFinder) and finder.project_root == project_root:
            return
    sys.meta_path.insert(0, _ProjectPycacheFinder(project_root))


_install_project_pycache_finder()

from fastapi import FastAPI, Header, HTTPException  # noqa: E402

from subtitles_service.application.analyze_session import AnalyzeSessionService  # noqa: E402
from subtitles_service.application.render_session import RenderSessionService  # noqa: E402
from subtitles_service.api.cors import (  # noqa: E402
    DEFAULT_CORS_ALLOW_ORIGIN_REGEX,
    add_cors_middleware,
)
from subtitles_service.api.errors import http_error  # noqa: E402
from subtitles_service.api.routes.subtitles import register_subtitle_routes  # noqa: E402
from subtitles_service.api.security import validate_voice_style_auth  # noqa: E402
from subtitles_service.storage.sqlite_store import SubtitleStore  # noqa: E402


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
