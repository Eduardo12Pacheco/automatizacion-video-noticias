from __future__ import annotations

import base64
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

# Make `subtitles_service` importable when pytest is run from the
# workspace root (where the root `pytest.ini` sets a different `pythonpath`).
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from subtitles_service.api.app import create_app  # noqa: E402
from subtitles_service.application.analyze_session import AnalyzeSessionService  # noqa: E402
from subtitles_service.storage.sqlite_store import SubtitleStore  # noqa: E402


# Use a fixed workspace root per test so we can inspect the produced files
# without leaking state between tests. Each test gets its own tmp_path.
@pytest.fixture
def workspace_root(tmp_path: Path) -> Path:
    root = tmp_path / "runtime-remote"
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture
def api_key() -> str:
    return "test-api-key-123"


@pytest.fixture
def basic_user() -> str:
    return "panelaudio-test"


@pytest.fixture
def basic_pass() -> str:
    return "PanelAudio-2026!test"


@pytest.fixture
def auth_headers(api_key: str) -> dict[str, str]:
    return {"X-Api-Key": api_key}


@pytest.fixture
def basic_auth_headers(basic_user: str, basic_pass: str) -> dict[str, str]:
    raw = f"{basic_user}:{basic_pass}".encode("utf-8")
    encoded = base64.b64encode(raw).decode("ascii")
    return {"Authorization": f"Basic {encoded}"}


@pytest.fixture
def store(workspace_root: Path) -> SubtitleStore:
    return SubtitleStore(workspace_root=workspace_root)


def _wait_for_analyze(store: SubtitleStore, session_id: str, timeout_s: float = 5.0) -> None:
    """Poll the latest analyze job until it leaves the 'queued' state.

    The auto-trigger runs the analyze on a background thread, so callers
    that want to assert on the snapshot need to wait for it to finish.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        job = store.get_latest_job_for_session(session_id, kind="analyze")
        if job and job.get("status") in {"succeeded", "failed"}:
            return
        time.sleep(0.05)


@pytest.fixture
def fake_segments() -> list[dict[str, Any]]:
    return [
        {"text": "hello world", "start_ms": 0, "end_ms": 1500},
        {"text": "this is a test", "start_ms": 1500, "end_ms": 3000},
    ]


@pytest.fixture
def fake_pipeline(fake_segments):
    """A no-op analyze pipeline that returns a couple of fake segments
    so we can exercise the upload -> analyze -> snapshot plumbing without
    loading Whisper or opus-mt in unit tests.
    """

    def _pipeline(source_video: Path, source_language: str, target_language: str, on_progress=None):
        # Mimic the real pipeline shape: each segment carries source_text
        # (what Whisper would have produced) and translated_text (what
        # opus-mt would have produced). The fixture gives us just `text`,
        # so we fill the rest with sensible values.
        if on_progress is not None:
            for pct in (10, 60, 95):
                on_progress(pct)
        return [
            {
                "source_text": seg.get("text", ""),
                "translated_text": seg.get("text", ""),
                "start_ms": int(seg.get("start_ms", 0)),
                "end_ms": int(seg.get("end_ms", 1)),
            }
            for seg in fake_segments
        ]

    return _pipeline


@pytest.fixture
def client(
    workspace_root: Path,
    api_key: str,
    basic_user: str,
    basic_pass: str,
    fake_pipeline,
) -> TestClient:
    """Build the TestClient with the analyze worker wired to a fake
    pipeline so we never have to load the real ASR/translation models
    during unit tests.
    """
    from subtitles_service.application.render_session import RenderSessionService

    store = SubtitleStore(workspace_root=workspace_root)
    analyze_worker = AnalyzeSessionService(store=store, pipeline=fake_pipeline)
    render_worker = RenderSessionService(store=store)
    app = create_app(
        workspace_root=workspace_root,
        api_key=api_key,
        basic_user=basic_user,
        basic_pass=basic_pass,
        store=store,
        analyze_worker=analyze_worker,
        render_worker=render_worker,
    )
    return TestClient(app)


@pytest.fixture
def waiting_client(client, store):
    """TestClient that auto-waits for the auto-triggered analyze to finish.

    Most tests just want to assert on the snapshot after upload; this
    helper waits for the background job to leave 'queued' before
    returning control, so individual tests don't sprinkle sleeps.
    """

    class _WaitingClient:
        def __init__(self, inner: TestClient, store: SubtitleStore) -> None:
            self._inner = inner
            self._store = store

        def post(self, *args, **kwargs):
            response = self._inner.post(*args, **kwargs)
            if response.status_code == 200:
                body = response.json()
                session_id = body.get("session_id") or body.get("session", {}).get("id")
                if session_id:
                    _wait_for_analyze(self._store, session_id)
            return response

        def get(self, *args, **kwargs):
            return self._inner.get(*args, **kwargs)

        def put(self, *args, **kwargs):
            return self._inner.put(*args, **kwargs)

        def delete(self, *args, **kwargs):
            return self._inner.delete(*args, **kwargs)

        @property
        def app(self):
            return self._inner.app

    return _WaitingClient(client, store)
