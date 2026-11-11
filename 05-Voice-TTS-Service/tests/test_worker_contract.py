from __future__ import annotations

import warnings
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from voice_tts_service.api.worker_app import create_app
from voice_tts_service.config.worker import WorkerConfig
from voice_tts_service.infrastructure.runner import QueueFullError
from voice_tts_service.storage.worker_store import JobsDB


class FakeRunner:
    def __init__(self, db: JobsDB) -> None:
        self.db = db
        self.enqueued: list[tuple[str, str]] = []
        self.started = False

    def start(self) -> None:
        self.started = True
        return None

    def enqueue(self, *, job_id: str, text: str, requested_by: str | None, voice_profile: str) -> None:
        self.enqueued.append((job_id, voice_profile))
        self.db.create_job(job_id=job_id, text=text, requested_by=requested_by, voice_profile=voice_profile)

    def queue_position(self, job_id: str) -> int | None:
        return 1 if job_id in {item[0] for item in self.enqueued} else None


class FullRunner(FakeRunner):
    def enqueue(self, *, job_id: str, text: str, requested_by: str | None, voice_profile: str) -> None:
        raise QueueFullError("full")


def _config(tmp_path: Path) -> WorkerConfig:
    return WorkerConfig(
        project_root=tmp_path,
        runtime_dir=tmp_path / "runtime",
        jobs_db=tmp_path / "runtime" / "jobs.db",
        input_dir=tmp_path / "runtime" / "inputs",
        output_dir=tmp_path / "runtime" / "output",
        segments_dir=tmp_path / "runtime" / "segments",
        python_exec="python",
        ref_audio_path=tmp_path / "refs" / "voz.wav",
        ref_text_path=tmp_path / "refs" / "voz.txt",
        config_yaml_path=tmp_path / "config" / "default.yaml",
        internal_token="internal-token",
        queue_max=20,
        job_timeout_sec=1200,
        preset=None,
        device=None,
    )


def _write_required_worker_files(cfg: WorkerConfig) -> None:
    cfg.ref_audio_path.parent.mkdir(parents=True, exist_ok=True)
    cfg.ref_audio_path.write_bytes(b"RIFFreference")
    cfg.ref_text_path.write_text("Texto de referencia", encoding="utf-8")
    cfg.config_yaml_path.parent.mkdir(parents=True, exist_ok=True)
    cfg.config_yaml_path.write_text("preset: balanced_default\n", encoding="utf-8")
    (cfg.project_root / "src").mkdir(parents=True, exist_ok=True)
    (cfg.project_root / "src" / "main.py").write_text("def main():\n    return 0\n", encoding="utf-8")


def test_worker_startup_lifespan_preserves_runtime_checks_and_runner_start(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    _write_required_worker_files(cfg)
    db = JobsDB(tmp_path / "jobs.db")
    runner = FakeRunner(db)
    app = create_app(cfg=cfg, db=db, runner=runner)

    with TestClient(app) as client:
        response = client.get("/internal/healthz")

    assert response.status_code == 200
    assert response.json()["runtime_dir"] == str(cfg.runtime_dir)
    assert cfg.input_dir.exists()
    assert cfg.output_dir.exists()
    assert cfg.segments_dir.exists()
    assert runner.started is True

    missing_cfg = _config(tmp_path / "missing")
    missing_app = create_app(cfg=missing_cfg, db=JobsDB(tmp_path / "missing.db"), runner=FakeRunner(db))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            with TestClient(missing_app):
                pass
        except RuntimeError as exc:
            assert str(exc).startswith("Faltan archivos obligatorios para worker:")
            assert str(missing_cfg.ref_audio_path) in str(exc)
        else:
            raise AssertionError("startup accepted missing worker runtime files")


def test_worker_app_factory_does_not_register_deprecated_on_event(tmp_path: Path) -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        create_app(cfg=_config(tmp_path), db=JobsDB(tmp_path / "jobs.db"), runner=FakeRunner(JobsDB(tmp_path / "runner.db")))

    assert [
        warning
        for warning in caught
        if issubclass(warning.category, DeprecationWarning) and "on_event is deprecated" in str(warning.message)
    ] == []


def test_worker_enqueue_is_token_protected_idempotent_and_maps_default_profile(tmp_path: Path) -> None:
    db = JobsDB(tmp_path / "jobs.db")
    runner = FakeRunner(db)
    client = TestClient(create_app(cfg=_config(tmp_path), db=db, runner=runner))
    payload = {"job_id": "job_123", "text": "Texto suficientemente largo para el worker interno.", "voice_profile": "default"}

    unauthorized = client.post("/internal/jobs", json=payload)
    assert unauthorized.status_code == 401

    created = client.post("/internal/jobs", headers={"x-internal-token": "internal-token"}, json=payload)
    duplicate = client.post("/internal/jobs", headers={"x-internal-token": "internal-token"}, json=payload)

    assert created.status_code == 202
    assert created.json() == {"job_id": "job_123", "status": "queued"}
    assert duplicate.status_code == 202
    assert duplicate.json() == {"job_id": "job_123", "status": "queued"}
    assert runner.enqueued == [("job_123", "balanced_default")]


def test_worker_queue_limit_status_and_artifact_codes_are_stable(tmp_path: Path) -> None:
    db = JobsDB(tmp_path / "jobs.db")
    client = TestClient(create_app(cfg=_config(tmp_path), db=db, runner=FullRunner(db)))
    payload = {"job_id": "job_full", "text": "Texto suficientemente largo para el worker interno."}

    full = client.post("/internal/jobs", headers={"x-internal-token": "internal-token"}, json=payload)
    assert full.status_code == 429
    assert full.json()["detail"] == "QUEUE_FULL"

    db.create_job("job_waiting", "Texto suficientemente largo para consultar estado.", "me", "balanced_default")
    status_response = client.get("/internal/jobs/job_waiting", headers={"x-internal-token": "internal-token"})
    assert status_response.status_code == 200
    assert status_response.json()["progress"] == {"stage": "queued", "percent": 0, "position": None}

    not_ready = client.get("/internal/jobs/job_waiting/artifact", headers={"x-internal-token": "internal-token"})
    assert not_ready.status_code == 409
    assert not_ready.json()["detail"] == "JOB_NOT_READY"

    missing = client.get("/internal/jobs/missing/artifact", headers={"x-internal-token": "internal-token"})
    assert missing.status_code == 404
    assert missing.json()["detail"] == "JOB_NOT_FOUND"


def test_worker_artifact_returns_wav_with_stable_filename(tmp_path: Path) -> None:
    db = JobsDB(tmp_path / "jobs.db")
    wav = tmp_path / "runtime" / "output" / "job_done.wav"
    wav.parent.mkdir(parents=True)
    wav.write_bytes(b"RIFFdoneWAVE")
    db.create_job("job_done", "Texto suficientemente largo para finalizar.", "me", "balanced_default")
    db.set_done("job_done", str(wav), str(tmp_path / "job_done.report.json"))

    client = TestClient(create_app(cfg=_config(tmp_path), db=db, runner=FakeRunner(db)))
    response = client.get("/internal/jobs/job_done/artifact", headers={"x-internal-token": "internal-token"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers["content-disposition"] == 'attachment; filename="job_done.wav"'
    assert response.content == b"RIFFdoneWAVE"


def test_worker_artifact_returns_410_when_done_wav_disappears(tmp_path: Path) -> None:
    db = JobsDB(tmp_path / "jobs.db")
    expired_wav = tmp_path / "runtime" / "output" / "job_expired.wav"
    db.create_job("job_expired", "Texto suficientemente largo para finalizar.", "me", "balanced_default")
    db.set_done("job_expired", str(expired_wav), str(tmp_path / "job_expired.report.json"))

    client = TestClient(create_app(cfg=_config(tmp_path), db=db, runner=FakeRunner(db)))
    response = client.get("/internal/jobs/job_expired/artifact", headers={"x-internal-token": "internal-token"})

    assert response.status_code == 410
    assert response.json()["detail"] == "ARTIFACT_EXPIRED"
