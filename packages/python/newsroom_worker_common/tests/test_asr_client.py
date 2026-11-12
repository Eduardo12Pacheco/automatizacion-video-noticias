from __future__ import annotations

import json
import urllib.error
from pathlib import Path
from typing import Any

import pytest

from newsroom_worker_common.asr_client import AsrWorkerClient, AsrWorkerError


class _Response:
    def __init__(self, payload: dict[str, Any]):
        self._payload = payload

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


class _Opener:
    def __init__(self, payload=None, error=None):
        self.payload = payload
        self.error = error
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append((request, timeout))
        if self.error is not None:
            raise self.error
        return _Response(self.payload)


def test_client_posts_audio_path_and_maps_segments(tmp_path: Path) -> None:
    opener = _Opener(
        {
            "segments": [
                {"id": "seg-1", "start_ms": 0, "end_ms": 1200, "text": " Hola "},
                {"id": "seg-2", "start_ms": 1200, "end_ms": 2200, "text": "  "},
            ],
            "language": "es",
            "device": "cpu",
            "fallback_used": True,
        }
    )
    client = AsrWorkerClient(base_url="http://asr:8765/", api_key="secret", opener=opener)

    segments, language = client.transcribe(tmp_path / "audio.wav", language="es")

    assert segments == [{"text": "Hola", "start_ms": 0, "end_ms": 1200}]
    assert language == "es"
    request, timeout = opener.requests[0]
    assert request.full_url == "http://asr:8765/api/radar/transcribe"
    assert request.get_header("X-api-key") == "secret"
    assert json.loads(request.data.decode("utf-8")) == {
        "audio_path": str(tmp_path / "audio.wav"),
        "language": "es",
    }
    assert timeout == 1800.0


def test_client_omits_auto_language_and_reports_typed_http_errors(tmp_path: Path) -> None:
    opener = _Opener({"segments": [], "language": None})
    client = AsrWorkerClient(base_url="http://asr:8765", opener=opener)
    client.transcribe(tmp_path / "audio.wav", language="auto")
    assert json.loads(opener.requests[0][0].data.decode("utf-8")) == {
        "audio_path": str(tmp_path / "audio.wav")
    }

    error = urllib.error.HTTPError(
        "http://asr:8765/api/radar/transcribe",
        409,
        "conflict",
        hdrs={},
        fp=_BytesIO(json.dumps({"detail": {"code": "gpu_busy", "message": "busy"}}).encode()),
    )
    with pytest.raises(AsrWorkerError) as failure:
        AsrWorkerClient(base_url="http://asr:8765", opener=_Opener(error=error)).transcribe(
            tmp_path / "audio.wav"
        )

    assert failure.value.code == "gpu_busy"
    assert failure.value.status == 409


def test_client_reports_unreachable_worker() -> None:
    with pytest.raises(AsrWorkerError) as failure:
        AsrWorkerClient(
            base_url="http://asr:8765",
            opener=_Opener(error=urllib.error.URLError("connection refused")),
        ).transcribe(Path("audio.wav"))

    assert failure.value.code == "asr_worker_unavailable"


class _BytesIO:
    def __init__(self, value: bytes):
        self._value = value

    def read(self) -> bytes:
        return self._value
