from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.models import TranscriptSegment
from app.settings import Settings
from app.store import JobStore
from app.worker import DependencyFailure


class _NullWorker:
    busy = False
    queue_depth = 0

    def enqueue(self, job_id: str) -> None:  # pragma: no cover - not used
        raise AssertionError("enqueue should not be called")


class _FakePreflight:
    def report(self):
        return {}


class _FakeTranscriber:
    device = "cpu"
    fallback_used = True

    def __init__(self, segments):
        self.segments = segments
        self.paths: list[Path] = []

    def transcribe(self, audio_path: Path):
        self.paths.append(audio_path)
        return self.segments, "es"


class _BusyTranscriber:
    device = "cuda"
    fallback_used = False

    def transcribe(self, audio_path: Path):
        raise DependencyFailure("gpu_busy", "GPU slot busy")


def _client(tmp_path, transcriber):
    settings = Settings(api_key="test-key", runtime_dir=tmp_path)
    return TestClient(
        create_app(
            settings=settings,
            store=JobStore(tmp_path),
            worker=_NullWorker(),
            preflight_checker=_FakePreflight(),
            transcriber=transcriber,
        )
    )


def _audio(tmp_path) -> Path:
    path = tmp_path / "clip.wav"
    path.write_bytes(b"RIFF")
    return path


def test_transcribe_endpoint_uses_shared_whisper_worker(tmp_path):
    audio = _audio(tmp_path)
    transcriber = _FakeTranscriber(
        [TranscriptSegment(id="seg-1", start_ms=0, end_ms=1500, text="Hola")]
    )
    client = _client(tmp_path, transcriber)

    response = client.post(
        "/api/radar/transcribe",
        headers={"x-api-key": "test-key"},
        json={"audio_path": str(audio)},
    )

    assert response.status_code == 200
    assert response.json() == {
        "segments": [{"id": "seg-1", "start_ms": 0, "end_ms": 1500, "text": "Hola"}],
        "language": "es",
        "device": "cpu",
        "fallback_used": True,
    }
    assert transcriber.paths == [audio]


def test_transcribe_endpoint_requires_api_key(tmp_path):
    client = _client(tmp_path, _FakeTranscriber([]))

    response = client.post(
        "/api/radar/transcribe",
        json={"audio_path": str(_audio(tmp_path))},
    )

    assert response.status_code == 401


def test_transcribe_endpoint_rejects_missing_and_unsupported_paths(tmp_path):
    client = _client(tmp_path, _FakeTranscriber([]))

    missing = client.post(
        "/api/radar/transcribe",
        headers={"x-api-key": "test-key"},
        json={"audio_path": str(tmp_path / "missing.wav")},
    )
    unsupported = client.post(
        "/api/radar/transcribe",
        headers={"x-api-key": "test-key"},
        json={"audio_path": str(tmp_path / "notes.txt")},
    )

    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "audio_not_found"
    assert unsupported.status_code == 422
    assert unsupported.json()["detail"]["code"] == "unsupported_audio_format"


def test_transcribe_endpoint_reports_busy_gpu_slot_as_conflict(tmp_path):
    client = _client(tmp_path, _BusyTranscriber())

    response = client.post(
        "/api/radar/transcribe",
        headers={"x-api-key": "test-key"},
        json={"audio_path": str(_audio(tmp_path))},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "gpu_busy"
