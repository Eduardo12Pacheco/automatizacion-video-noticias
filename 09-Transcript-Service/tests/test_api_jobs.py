from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.models import JobStatus, MentionMatch, TranscriptSegment
from app.settings import Settings
from app.store import JobStore
from app.worker import TranscriptWorker


class CompletingWorker:
    def __init__(self, store: JobStore):
        self.store = store
        self.busy = False

    @property
    def queue_depth(self) -> int:
        return 0

    def enqueue(self, job_id: str) -> None:
        self.store.mark_running(job_id)
        self.store.save_transcript(
            job_id,
            [TranscriptSegment(id="seg-1", start_ms=12000, end_ms=15300, text="Argentina pressed high.")],
        )
        self.store.save_mentions(
            job_id,
            [
                MentionMatch(
                    keyword="argentina",
                    canonical="Argentina",
                    segment_id="seg-1",
                    start_ms=12000,
                    end_ms=15300,
                    text="Argentina pressed high.",
                    context_before=None,
                    context_after=None,
                )
            ],
        )
        self.store.mark_succeeded(job_id)


class FixedPreflightChecker:
    def report(self):
        return {
            "ffmpeg": {"status": "ok", "path": r"C:\\ffmpeg\\bin\\ffmpeg.exe"},
            "yt_dlp": {"status": "missing", "path": None},
            "faster_whisper": {"status": "ok", "model": "large-v3", "device": "cuda", "compute_type": "float16"},
        }


class BlockingDownloader:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def download(self, url: str, job_dir: Path) -> Path:
        self.started.set()
        self.release.wait(timeout=1.0)
        source = job_dir / "source.mp4"
        source.write_text(f"downloaded {url}", encoding="utf-8")
        return source


class FakeAudioExtractor:
    def extract_16khz_wav(self, source_path: Path, audio_dir: Path) -> Path:
        audio_dir.mkdir(parents=True, exist_ok=True)
        wav = audio_dir / "audio-16khz.wav"
        wav.write_text(source_path.name, encoding="utf-8")
        return wav


class FakeTranscriber:
    def transcribe(self, audio_path: Path):
        return [TranscriptSegment(id="seg-1", start_ms=12000, end_ms=15300, text="Argentina pressed high.")], "en"


def _client(tmp_path):
    settings = Settings(api_key="test-key", runtime_dir=tmp_path, cors_origins=["https://panel.example"], media_url_dns_check=False)
    store = JobStore(tmp_path)
    worker = CompletingWorker(store)
    app = create_app(settings=settings, store=store, worker=worker, preflight_checker=FixedPreflightChecker())
    return TestClient(app), store


def _headers() -> dict[str, str]:
    return {"x-api-key": "test-key"}


def _job_payload() -> dict:
    return {
        "url": "https://www.youtube.com/watch?v=abc123",
        "countries": ["argentina"],
        "extra_keywords": ["pressing"],
    }


def test_health_requires_x_api_key_before_reporting_preflight(tmp_path):
    client, _ = _client(tmp_path)

    response = client.get("/api/radar/health")

    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "unauthorized", "message": "Invalid or missing API key"}}


def test_health_reports_typed_dependency_failures_with_api_key(tmp_path):
    client, _ = _client(tmp_path)

    response = client.get("/api/radar/health", headers=_headers())

    assert response.status_code == 200
    assert response.json() == {
        "status": "degraded",
        "worker": {"busy": False, "queue_depth": 0},
        "runtime": {
            "ffmpeg": {"status": "ok", "path": r"C:\\ffmpeg\\bin\\ffmpeg.exe"},
            "yt_dlp": {"status": "missing", "path": None},
            "faster_whisper": {"status": "ok", "model": "large-v3", "device": "cuda", "compute_type": "float16"},
            "whisper_model": "large-v3",
            "whisper_model_path": None,
            "device": "cuda",
            "compute_type": "float16",
        },
        "failures": [
            {
                "code": "dependency_missing",
                "dependency": "yt_dlp",
                "message": "Required dependency yt_dlp is missing",
            }
        ],
    }
    assert "test-key" not in response.text


def test_live_liveness_endpoint_is_public_and_does_not_expose_preflight_details(tmp_path):
    client, _ = _client(tmp_path)

    response = client.get("/api/radar/live")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert "runtime" not in response.text


def test_cors_preflight_for_authenticated_radar_jobs_is_allowed_without_api_key(tmp_path):
    client, _ = _client(tmp_path)

    response = client.options(
        "/api/radar/jobs",
        headers={
            "Origin": "https://panel.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-api-key,content-type",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://panel.example"
    assert "POST" in response.headers["access-control-allow-methods"]
    assert "x-api-key" in response.headers["access-control-allow-headers"]


def test_actual_radar_methods_remain_authenticated_after_preflight_is_allowed(tmp_path):
    client, store = _client(tmp_path)
    queued = store.create_job(url="https://www.youtube.com/watch?v=protected", countries=["colombia"], extra_keywords=[])

    protected_responses = [
        client.get("/api/radar/jobs"),
        client.post("/api/radar/jobs", json=_job_payload()),
        client.delete(f"/api/radar/jobs/{queued.job_id}"),
    ]

    assert [response.status_code for response in protected_responses] == [401, 401, 401]
    assert all(
        response.json() == {"detail": {"code": "unauthorized", "message": "Invalid or missing API key"}}
        for response in protected_responses
    )


def test_health_remains_ok_when_all_preflight_dependencies_are_available(tmp_path):
    class HealthyPreflightChecker:
        def report(self):
            return {
                "ffmpeg": {"status": "ok", "path": r"C:\\ffmpeg\\bin\\ffmpeg.exe"},
                "yt_dlp": {"status": "ok", "path": r"C:\\Python\\Scripts\\yt-dlp.exe"},
                "faster_whisper": {"status": "ok", "model": "large-v3", "device": "cuda", "compute_type": "float16"},
            }

    settings = Settings(api_key="test-key", runtime_dir=tmp_path, cors_origins=["https://panel.example"], media_url_dns_check=False)
    store = JobStore(tmp_path)
    worker = CompletingWorker(store)
    app = create_app(settings=settings, store=store, worker=worker, preflight_checker=HealthyPreflightChecker())

    response = TestClient(app).get("/api/radar/health", headers=_headers())

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["failures"] == []


def test_jobs_require_x_api_key_before_accepting_work(tmp_path):
    client, _ = _client(tmp_path)

    response = client.post("/api/radar/jobs", json=_job_payload())

    assert response.status_code == 401
    assert response.json() == {"detail": {"code": "unauthorized", "message": "Invalid or missing API key"}}


def test_submit_job_exposes_status_history_transcript_and_mentions(tmp_path):
    client, _ = _client(tmp_path)

    created = client.post("/api/radar/jobs", headers=_headers(), json=_job_payload())


    assert created.status_code == 201
    assert created.json()["status"] == JobStatus.QUEUED
    job_id = created.json()["job_id"]

    detail = client.get(f"/api/radar/jobs/{job_id}", headers=_headers())
    assert detail.status_code == 200
    assert detail.json()["status"] == JobStatus.SUCCEEDED
    assert detail.json()["stage"] == "succeeded"
    assert detail.json()["progress"] == 100
    assert detail.json()["selected_countries"] == ["argentina"]
    assert detail.json()["artifacts"]["transcript"] is True
    assert detail.json()["artifacts"]["mentions"] is True

    history = client.get("/api/radar/jobs", headers=_headers())
    assert history.status_code == 200
    assert history.json()["items"][0]["job_id"] == job_id
    assert history.json()["items"][0]["mention_count"] == 1

    transcript = client.get(f"/api/radar/jobs/{job_id}/transcript", headers=_headers())
    assert transcript.status_code == 200
    assert transcript.json()["text"] == "(00:12) Argentina pressed high."

    mentions = client.get(f"/api/radar/jobs/{job_id}/mentions", headers=_headers())
    assert mentions.status_code == 200
    assert mentions.json()["matches"][0]["canonical"] == "Argentina"


def test_job_path_params_reject_traversal_with_typed_error(tmp_path):
    client, _ = _client(tmp_path)

    response = client.get("/api/radar/jobs/not-a-safe-job-id", headers=_headers())

    assert response.status_code == 400
    assert response.json() == {"detail": {"code": "invalid_job_id", "message": "Job id must be a 32 character lowercase hex value"}}


def test_submit_job_rejects_unsafe_url_before_worker_enqueue(tmp_path):
    client, store = _client(tmp_path)

    response = client.post(
        "/api/radar/jobs",
        headers=_headers(),
        json={"url": "file:///C:/Windows/win.ini", "countries": ["argentina"], "extra_keywords": []},
    )

    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "invalid_url", "message": "URL must use http or https"}}
    assert store.list_history() == []


def test_submit_job_rejects_non_youtube_url_before_worker_enqueue(tmp_path):
    client, store = _client(tmp_path)

    response = client.post(
        "/api/radar/jobs",
        headers=_headers(),
        json={"url": "https://video.example/watch?v=abc123", "countries": ["argentina"], "extra_keywords": []},
    )

    assert response.status_code == 422
    assert response.json() == {"detail": {"code": "invalid_url", "message": "URL host is not allowed"}}
    assert store.list_history() == []


def test_startup_recovery_allows_job_creation_after_orphaned_running_job(tmp_path):
    settings = Settings(api_key="test-key", runtime_dir=tmp_path, cors_origins=["https://panel.example"], media_url_dns_check=False)
    store = JobStore(tmp_path)
    orphaned = store.create_job(url="https://www.youtube.com/watch?v=orphaned", countries=["argentina"], extra_keywords=[])
    store.mark_running(orphaned.job_id)
    app = create_app(
        settings=settings,
        store=store,
        worker=CompletingWorker(store),
        preflight_checker=FixedPreflightChecker(),
    )

    created = TestClient(app).post("/api/radar/jobs", headers=_headers(), json=_job_payload())

    assert created.status_code == 201
    assert store.get_job(orphaned.job_id).status == JobStatus.FAILED
    assert store.get_job(orphaned.job_id).error == {
        "code": "service_restarted",
        "message": "Job was interrupted by service restart",
    }


def test_startup_cleanup_removes_expired_non_active_runtime_outputs_without_losing_history(tmp_path):
    settings = Settings(api_key="test-key", runtime_dir=tmp_path, cors_origins=["https://panel.example"], cleanup_ttl_seconds=3600, media_url_dns_check=False)
    store = JobStore(tmp_path)
    expired = store.create_job(url="https://www.youtube.com/watch?v=expired", countries=["argentina"], extra_keywords=[])
    store.save_export_text(expired.job_id, "old export")
    store.mark_succeeded(expired.job_id)
    expired_record = store.get_job(expired.job_id).model_dump(mode="json")
    expired_record["updated_at"] = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    (tmp_path / "jobs" / expired.job_id / "job.json").write_text(json.dumps(expired_record), encoding="utf-8")

    create_app(settings=settings, store=store, worker=CompletingWorker(store), preflight_checker=FixedPreflightChecker())

    assert not (tmp_path / "jobs" / expired.job_id / "export.txt").exists()
    assert store.list_history()[0].job_id == expired.job_id


def test_submit_job_returns_before_worker_finishes_processing(tmp_path):
    settings = Settings(api_key="test-key", runtime_dir=tmp_path, cors_origins=["https://panel.example"], media_url_dns_check=False)
    store = JobStore(tmp_path)
    downloader = BlockingDownloader()
    worker = TranscriptWorker(
        settings=settings,
        store=store,
        downloader=downloader,
        audio_extractor=FakeAudioExtractor(),
        transcriber=FakeTranscriber(),
    )
    app = create_app(settings=settings, store=store, worker=worker, preflight_checker=FixedPreflightChecker())

    started_at = time.monotonic()
    try:
        created = TestClient(app).post("/api/radar/jobs", headers=_headers(), json=_job_payload())
        elapsed = time.monotonic() - started_at

        assert created.status_code == 201
        assert created.json()["status"] == JobStatus.QUEUED
        assert elapsed < 0.5
        assert downloader.started.wait(timeout=0.5)
        assert worker.busy is True
    finally:
        downloader.release.set()
        deadline = time.monotonic() + 1.0
        while worker.busy and time.monotonic() < deadline:
            time.sleep(0.01)


def test_catalog_summary_summary_export_cancel_and_delete_endpoints(tmp_path):
    client, store = _client(tmp_path)

    catalog = client.get("/api/radar/catalog", headers=_headers())
    assert catalog.status_code == 200
    assert [country["code"] for country in catalog.json()["countries"]] == [
        "ecuador",
        "colombia",
        "argentina",
        "uruguay",
        "paraguay",
        "mexico",
    ]

    created = client.post("/api/radar/jobs", headers=_headers(), json=_job_payload())
    job_id = created.json()["job_id"]
    store.save_summary(job_id, {"items": [{"label": "Argentina", "count": 1, "timestamps": ["00:12"]}]})
    store.save_export_text(job_id, "Instrucciones para GPT\n(00:12) Argentina pressed high.")

    summary = client.get(f"/api/radar/jobs/{job_id}/summary", headers=_headers())
    assert summary.status_code == 200
    assert summary.json()["items"][0]["label"] == "Argentina"

    export = client.get(f"/api/radar/jobs/{job_id}/export.txt", headers=_headers())
    assert export.status_code == 200
    assert export.headers["content-type"].startswith("text/plain")
    assert "(00:12) Argentina pressed high." in export.text

    deleted = client.delete(f"/api/radar/jobs/{job_id}", headers=_headers())
    assert deleted.status_code == 200
    assert deleted.json() == {"job_id": job_id, "status": "deleted"}
    assert store.list_history() == []

    queued = store.create_job(url="https://www.youtube.com/watch?v=queued", countries=["colombia"], extra_keywords=[])
    cancelled = client.post(f"/api/radar/jobs/{queued.job_id}/cancel", headers=_headers())
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"


def test_cleanup_linked_artifacts_endpoint_hard_deletes_terminal_jobs_without_network(tmp_path):
    client, store = _client(tmp_path)
    created = client.post("/api/radar/jobs", headers=_headers(), json=_job_payload())
    job_id = created.json()["job_id"]
    store.save_summary(job_id, {"items": [{"label": "Argentina", "count": 1}]})
    store.save_export_text(job_id, "generated export")

    response = client.post(
        "/api/radar/cleanup/linked-artifacts",
        headers=_headers(),
        json={
            "job_ids": [job_id],
            "urls": ["https://www.youtube.com/watch?v=missing"],
            "video_ids": [],
            "mode": "apply",
        },
    )

    assert response.status_code == 200
    assert [item["job_id"] for item in response.json()["deleted"]] == [job_id]
    assert response.json()["missing"] == ["https://www.youtube.com/watch?v=missing"]
    assert store.list_history() == []
    assert not (tmp_path / "jobs" / job_id).exists()


def test_submit_rejects_concurrent_active_job_with_typed_busy_error(tmp_path):
    client, store = _client(tmp_path)
    store.create_job(url="https://www.youtube.com/watch?v=active", target={"type": "player", "name": "Messi"}, extra_keywords=[])

    response = client.post("/api/radar/jobs", headers=_headers(), json=_job_payload())

    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "busy", "message": "A radar job is already active"}}
