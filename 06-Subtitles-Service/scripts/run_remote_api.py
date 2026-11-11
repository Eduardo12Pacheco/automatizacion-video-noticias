from __future__ import annotations

import os
from pathlib import Path

import uvicorn

from subtitles_service.api.app import create_app


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Falta {name} en .env.local")
    return value


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    workspace_root = Path(
        os.getenv("SUBTITLES_REMOTE_WORKSPACE_ROOT", root / "runtime-remote")
    ).resolve()
    host = os.getenv("SUBTITLES_REMOTE_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.getenv("SUBTITLES_REMOTE_PORT", "8092"))

    app = create_app(
        workspace_root=workspace_root,
        api_key=_required_env("SUBTITLES_REMOTE_API_KEY"),
        basic_user=_required_env("SUBTITLES_REMOTE_BASIC_USER"),
        basic_pass=_required_env("SUBTITLES_REMOTE_BASIC_PASS"),
    )

    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
