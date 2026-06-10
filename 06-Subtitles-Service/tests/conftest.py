from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Make `subtitles_service` importable when pytest is run from the
# workspace root (where the root `pytest.ini` sets a different `pythonpath`).
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from subtitles_service.api.app import create_app  # noqa: E402
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


@pytest.fixture
def client(workspace_root: Path, api_key: str, basic_user: str, basic_pass: str) -> TestClient:
    app = create_app(
        workspace_root=workspace_root,
        api_key=api_key,
        basic_user=basic_user,
        basic_pass=basic_pass,
    )
    return TestClient(app)
