"""Adhoc ASGI loader so `python -m uvicorn` can find the FastAPI app.

Production still uses `python -m scripts.run_remote_api` (which calls
`uvicorn.run` itself), but local smoke tests benefit from a module-level
`app` symbol that uvicorn can import.
"""
from __future__ import annotations

import os
from pathlib import Path

from subtitles_service.api.app import create_app


_ROOT = Path(__file__).resolve().parents[1]
_WORKSPACE = Path(
    os.getenv("SUBTITLES_REMOTE_WORKSPACE_ROOT", _ROOT / "runtime-remote")
).resolve()


app = create_app(
    workspace_root=_WORKSPACE,
    api_key=os.environ["SUBTITLES_REMOTE_API_KEY"],
    basic_user=os.environ["SUBTITLES_REMOTE_BASIC_USER"],
    basic_pass=os.environ["SUBTITLES_REMOTE_BASIC_PASS"],
)
