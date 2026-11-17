from __future__ import annotations

import base64
import warnings
from dataclasses import replace
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from voice_tts_service.api.orchestrator_app import create_app
from voice_tts_service.config.orchestrator import OrchestratorConfig
from voice_tts_service.storage.orchestrator_store import OrchestratorStore


class FakeWorkerClient:
    def __init__(
        self,
        status_payload: dict | None = None,
        artifact: bytes = b"RIFFfakeWAVE",
        post_response: httpx.Response | None = None,
        artifact_response: httpx.Response | None = None,
        status_responses: list[httpx.Response] | None = None,
    ) -> None:
        self.posts: list[tuple[str, dict]] = []
        self.gets: list[str] = []
        self.post_response = post_response
        self.artifact_response = artifact_response
        self.status_responses = list(status_responses or [])
        self.status_payload = status_payload or {
            "job_id": "job_existing",
            "status": "done",
            "progress": {"stage": "done", "percent": 101},
            "created_at": "2026-05-12T10:00:00+00:00",
            "started_at": "2026-05-12T10:01:00+00:00",
            "finished_at": "2026-05-12T10:02:00+00:00",
            "error": None,
        }
        self.artifact = artifact

    async def post(self, path: str, payload: dict) -> httpx.Response:
        self.posts.append((path, payload))
        if self.post_response is not None:
            return self.post_response
        return httpx.Response(202, json={"job_id": payload["job_id"], "status": "queued"})

    async def get(self, path: str) -> httpx.Response:
        self.gets.append(path)
        if path.endswith("/artifact"):
            if self.artifact_response is not None:
                return self.artifact_response
            return httpx.Response(
                200,
                content=self.artifact,
                headers={"content-type": "audio/wav", "content-disposition": 'attachment; filename="job_existing.wav"'},
            )
        if self.status_responses:
            return self.status_responses.pop(0)
        return httpx.Response(200, json=self.status_payload)


def _config(tmp_path: Path, *, stream_poll_interval_sec: int = 1, stream_heartbeat_sec: int = 5) -> OrchestratorConfig:
    return OrchestratorConfig(
        runtime_dir=tmp_path,
        worker_base_url="http://worker.local",
        worker_internal_token="internal-token",
        frontend_api_key="public-key",
        basic_user="admin",
        basic_pass="secret",
        request_timeout_sec=30,
        poll_timeout_sec=30,
        rate_limit_per_min=10,
        queue_max_hint=20,
        stream_poll_interval_sec=stream_poll_interval_sec,
        stream_heartbeat_sec=stream_heartbeat_sec,
        allowed_origins=["http://localhost:8080"],
    )


def _headers() -> dict[str, str]:
    token = base64.b64encode(b"admin:secret").decode("ascii")
    return {"Authorization": f"Basic {token}", "x-api-key": "public-key", "x-user-email": "USER@Example.COM"}


def test_create_job_preserves_auth_response_shape_and_default_voice_mapping(tmp_path: Path) -> None:
    worker = FakeWorkerClient()
    app = create_app(cfg=_config(tmp_path), store=OrchestratorStore(tmp_path / "orchestrator.db"), worker_client=worker)

    response = TestClient(app).post(
        "/api/tts/jobs",
        headers=_headers(),
        json={"text": "Este texto tiene longitud suficiente para crear un trabajo.", "voice_profile": "default"},
    )

    assert response.status_code == 202
    body = response.json()
    assert set(body) == {"job_id", "status", "position", "eta_seconds", "created_at"}
    assert body["job_id"].startswith("job_")
    assert body["status"] == "queued"
    assert worker.posts[0][0] == "/internal/jobs"
    assert worker.posts[0][1]["voice_profile"] == "balanced_default"
    assert worker.posts[0][1]["requested_by"] == "user@example.com"


def test_public_status_download_and_error_envelopes_remain_stable(tmp_path: Path) -> None:
    worker = FakeWorkerClient()
    app = create_app(cfg=_config(tmp_path), store=OrchestratorStore(tmp_path / "orchestrator.db"), worker_client=worker)
    client = TestClient(app)

    unauthorized = client.get("/api/tts/jobs/job_existing")
    assert unauthorized.status_code == 401
    assert unauthorized.json() == {"error": {"code": "UNAUTHORIZED", "message": "Unauthorized.", "details": None}}

    status_response = client.get("/api/tts/jobs/job_existing", headers=_headers())
    assert status_response.status_code == 200
    assert status_response.json()["progress"]["percent"] == 100
    assert status_response.json()["download_url"] == "/api/tts/jobs/job_existing/download"

    download = client.get("/api/tts/jobs/job_existing/download", headers=_headers())
    assert download.status_code == 200
    assert download.headers["content-type"].startswith("audio/wav")
    assert download.headers["content-disposition"] == 'attachment; filename="job_existing.wav"'
    assert download.content == b"RIFFfakeWAVE"


def test_sse_emits_terminal_status_frame(tmp_path: Path) -> None:
    worker = FakeWorkerClient(status_payload={"job_id": "job_done", "status": "done", "progress": {"stage": "done", "percent": 100}})
    app = create_app(cfg=_config(tmp_path), store=OrchestratorStore(tmp_path / "orchestrator.db"), worker_client=worker)

    response = TestClient(app).get("/api/tts/jobs/job_done/events", headers=_headers())

    assert response.status_code == 200
    assert "event: status" in response.text
    assert '"job_id": "job_done"' in response.text
    assert '"status": "done"' in response.text


def test_public_status_and_sse_expose_cancelled_as_terminal_without_download(tmp_path: Path) -> None:
    worker = FakeWorkerClient(
        status_payload={
            "job_id": "job_cancelled",
            "status": "cancelled",
            "progress": {"stage": "cancelled", "percent": 33},
            "created_at": "2026-05-12T10:00:00+00:00",
            "started_at": "2026-05-12T10:01:00+00:00",
            "finished_at": "2026-05-12T10:02:00+00:00",
            "error": {"code": "CANCELLED", "message": "Cancelado por el usuario."},
        }
    )
    app = create_app(cfg=_config(tmp_path), store=OrchestratorStore(tmp_path / "orchestrator.db"), worker_client=worker)
    client = TestClient(app)

    status_response = client.get("/api/tts/jobs/job_cancelled", headers=_headers())
    events_response = client.get("/api/tts/jobs/job_cancelled/events", headers=_headers())

    assert status_response.status_code == 200
    assert status_response.json() == {
        "job_id": "job_cancelled",
        "status": "cancelled",
        "progress": {"stage": "cancelled", "percent": 33},
        "created_at": "2026-05-12T10:00:00+00:00",
        "started_at": "2026-05-12T10:01:00+00:00",
        "finished_at": "2026-05-12T10:02:00+00:00",
        "error": {"code": "CANCELLED", "message": "Cancelado por el usuario."},
        "download_url": None,
    }
    assert events_response.status_code == 200
    assert "event: status" in events_response.text
    assert '"status": "cancelled"' in events_response.text
    assert worker.gets == ["/internal/jobs/job_cancelled", "/internal/jobs/job_cancelled"]


def test_orchestrator_startup_lifespan_preserves_runtime_checks(tmp_path: Path) -> None:
    cfg = _config(tmp_path / "runtime")
    app = create_app(cfg=cfg, store=OrchestratorStore(tmp_path / "orchestrator.db"), worker_client=FakeWorkerClient())

    with TestClient(app) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json()["worker_base_url"] == "http://worker.local"
    assert cfg.runtime_dir.exists()

    missing_token_cfg = replace(_config(tmp_path / "missing-token"), worker_internal_token="")
    missing_token_app = create_app(
        cfg=missing_token_cfg,
        store=OrchestratorStore(tmp_path / "missing-token.db"),
        worker_client=FakeWorkerClient(),
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        try:
            with TestClient(missing_token_app):
                pass
        except RuntimeError as exc:
            assert str(exc) == "TTS_WORKER_INTERNAL_TOKEN is required"
        else:
            raise AssertionError("startup accepted an empty worker internal token")


def test_orchestrator_app_factory_does_not_register_deprecated_on_event(tmp_path: Path) -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        create_app(cfg=_config(tmp_path), store=OrchestratorStore(tmp_path / "orchestrator.db"), worker_client=FakeWorkerClient())

    assert [
        warning
        for warning in caught
        if issubclass(warning.category, DeprecationWarning) and "on_event is deprecated" in str(warning.message)
    ] == []


def test_public_error_and_download_edge_cases_use_stable_envelopes(tmp_path: Path) -> None:
    worker = FakeWorkerClient(
        post_response=httpx.Response(429, json={"detail": "QUEUE_FULL"}),
        artifact_response=httpx.Response(410, json={"detail": "ARTIFACT_EXPIRED"}),
        status_responses=[httpx.Response(404, json={"detail": "JOB_NOT_FOUND"})],
    )
    app = create_app(cfg=_config(tmp_path), store=OrchestratorStore(tmp_path / "orchestrator.db"), worker_client=worker)
    client = TestClient(app)

    invalid = client.post("/api/tts/jobs", headers=_headers(), json={"text": "corto"})
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "INVALID_TEXT"

    rate_limited = client.post(
        "/api/tts/jobs",
        headers=_headers(),
        json={"text": "Este texto tiene longitud suficiente para crear un trabajo."},
    )
    assert rate_limited.status_code == 429
    assert rate_limited.json() == {
        "error": {"code": "QUEUE_FULL", "message": "The queue is full. Try again later.", "details": None}
    }

    missing = client.get("/api/tts/jobs/job_missing", headers=_headers())
    assert missing.status_code == 404
    assert missing.json() == {"error": {"code": "JOB_NOT_FOUND", "message": "The requested job does not exist.", "details": None}}

    expired = client.get("/api/tts/jobs/job_expired/download", headers=_headers())
    assert expired.status_code == 410
    assert expired.json() == {
        "error": {"code": "ARTIFACT_EXPIRED", "message": "The artifact is no longer available.", "details": None}
    }


def test_public_non_ready_and_worker_failure_download_envelopes(tmp_path: Path) -> None:
    worker = FakeWorkerClient(artifact_response=httpx.Response(409, json={"detail": "JOB_NOT_READY"}))
    app = create_app(cfg=_config(tmp_path), store=OrchestratorStore(tmp_path / "orchestrator.db"), worker_client=worker)
    client = TestClient(app)

    not_ready = client.get("/api/tts/jobs/job_waiting/download", headers=_headers())
    assert not_ready.status_code == 409
    assert not_ready.json() == {"error": {"code": "JOB_NOT_READY", "message": "The job has not finished yet.", "details": None}}

    failing_worker = FakeWorkerClient(post_response=httpx.Response(500, json={"detail": "boom"}))
    failing_app = create_app(cfg=_config(tmp_path), store=OrchestratorStore(tmp_path / "orchestrator-fail.db"), worker_client=failing_worker)
    worker_failure = TestClient(failing_app).post(
        "/api/tts/jobs",
        headers=_headers(),
        json={"text": "Este texto tiene longitud suficiente para crear un trabajo."},
    )
    assert worker_failure.status_code == 500
    assert worker_failure.json() == {
        "error": {"code": "INTERNAL_ERROR", "message": "The worker returned an error while creating the job.", "details": None}
    }


def test_sse_emits_running_error_and_heartbeat_variants(tmp_path: Path) -> None:
    queued = httpx.Response(200, json={"job_id": "job_stream", "status": "running", "progress": {"stage": "synthesizing", "percent": 42}})
    done = httpx.Response(200, json={"job_id": "job_stream", "status": "done", "progress": {"stage": "done", "percent": 100}})
    worker = FakeWorkerClient(status_responses=[queued, queued, queued, queued, queued, queued, done])
    cfg = _config(tmp_path, stream_poll_interval_sec=0, stream_heartbeat_sec=0)
    app = create_app(cfg=cfg, store=OrchestratorStore(tmp_path / "orchestrator.db"), worker_client=worker)

    response = TestClient(app).get("/api/tts/jobs/job_stream/events", headers=_headers())

    assert response.status_code == 200
    assert "event: status" in response.text
    assert '"status": "running"' in response.text
    assert '"status": "done"' in response.text
    assert ": heartbeat" in response.text

    error_worker = FakeWorkerClient(status_responses=[httpx.Response(404, json={"detail": "JOB_NOT_FOUND"})])
    error_app = create_app(cfg=cfg, store=OrchestratorStore(tmp_path / "orchestrator-error.db"), worker_client=error_worker)
    error_response = TestClient(error_app).get("/api/tts/jobs/missing/events", headers=_headers())
    assert error_response.status_code == 200
    assert "event: error" in error_response.text
    assert '"code": "JOB_NOT_FOUND"' in error_response.text
