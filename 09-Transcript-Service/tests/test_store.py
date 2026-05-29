from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from app.models import MentionMatch, TranscriptSegment
from app.store import ArtifactWriteError, JobIdError, JobStore


def test_store_creates_job_folder_artifacts_and_index_history(tmp_path):
    store = JobStore(tmp_path)

    job = store.create_job(
        url="https://video.example/watch?v=abc123",
        target={"type": "country", "name": "Argentina"},
        extra_keywords=["scaloni"],
    )
    store.mark_running(job.job_id)
    store.save_transcript(job.job_id, [TranscriptSegment(id="s1", start_ms=62000, end_ms=65000, text="Gol de Argentina")])
    store.save_mentions(
        job.job_id,
        [
            MentionMatch(
                keyword="argentina",
                canonical="Argentina",
                segment_id="s1",
                start_ms=62000,
                end_ms=65000,
                text="Gol de Argentina",
            )
        ],
    )
    store.mark_succeeded(job.job_id)

    job_dir = tmp_path / "jobs" / job.job_id
    assert (job_dir / "job.json").exists()
    assert (job_dir / "transcript.json").exists()
    assert (job_dir / "mentions.json").exists()
    assert (tmp_path / "jobs" / "index.json").exists()

    index = json.loads((tmp_path / "jobs" / "index.json").read_text(encoding="utf-8"))
    assert index["items"][0]["job_id"] == job.job_id
    assert index["items"][0]["status"] == "succeeded"
    assert index["items"][0]["mention_count"] == 1


def test_store_reports_active_jobs_and_preserves_copyable_transcript_lines(tmp_path):
    store = JobStore(tmp_path)
    job = store.create_job(
        url="https://video.example/watch?v=active",
        target={"type": "player", "name": "Luis Díaz"},
        extra_keywords=[],
    )

    assert store.has_active_job() is True

    store.save_transcript(
        job.job_id,
        [
            TranscriptSegment(id="s1", start_ms=1000, end_ms=2000, text="Arranca el partido"),
            TranscriptSegment(id="s2", start_ms=61000, end_ms=64000, text="Luis Díaz ataca"),
        ],
    )
    store.mark_succeeded(job.job_id)

    assert store.has_active_job() is False
    assert store.get_transcript(job.job_id).text == "(00:01) Arranca el partido\n(01:01) Luis Díaz ataca"


def test_store_persists_country_job_metadata_summary_export_and_hard_delete(tmp_path):
    store = JobStore(tmp_path)

    job = store.create_job(url="https://video.example/watch?v=abc123", countries=["colombia", "ecuador"], extra_keywords=["bloque alto"])
    store.update_metadata(job.job_id, title="Rueda de prensa", detected_language="fr")
    store.save_transcript(job.job_id, [TranscriptSegment(id="s1", start_ms=12000, end_ms=15000, text="James Rodrigue habla.")])
    store.save_summary(job.job_id, {"items": [{"label": "James Rodríguez", "count": 1, "timestamps": ["00:12"]}]})
    store.save_export_text(job.job_id, "PROMPT\n(00:12) James Rodrigue habla.")
    store.mark_succeeded(job.job_id)

    saved = store.get_job(job.job_id)
    assert saved.selected_countries == ["colombia", "ecuador"]
    assert saved.title == "Rueda de prensa"
    assert saved.detected_language == "fr"
    assert saved.artifacts["summary"] is True
    assert saved.artifacts["export_txt"] is True
    assert store.get_summary(job.job_id)["items"][0]["timestamps"] == ["00:12"]
    assert store.get_export_text(job.job_id).startswith("PROMPT")
    assert store.list_history()[0].title == "Rueda de prensa"

    store.delete_job(job.job_id)

    assert not (tmp_path / "jobs" / job.job_id).exists()
    assert store.list_history() == []


def test_store_cancel_and_delete_active_jobs_remove_artifacts_safely(tmp_path):
    store = JobStore(tmp_path)
    queued = store.create_job(url="https://video.example/queued", countries=["argentina"], extra_keywords=[])

    cancelled = store.cancel_job(queued.job_id)

    assert cancelled.status == "cancelled"
    assert store.has_active_job() is False

    running = store.create_job(url="https://video.example/running", countries=["argentina"], extra_keywords=[])
    store.mark_running(running.job_id)
    pending_delete = store.delete_job(running.job_id)

    assert pending_delete.status == "delete_requested"
    assert store.get_job(running.job_id).delete_requested is True


def test_store_recovers_orphaned_active_jobs_after_restart(tmp_path):
    store = JobStore(tmp_path)
    queued = store.create_job(url="https://video.example/queued", countries=["argentina"], extra_keywords=[])
    running = store.create_job(url="https://video.example/running", countries=["colombia"], extra_keywords=[])
    store.mark_running(running.job_id)
    deleting = store.create_job(url="https://video.example/delete", countries=["ecuador"], extra_keywords=[])
    store.delete_job(deleting.job_id)

    recovered = store.recover_orphaned_active_jobs()

    assert {job.job_id for job in recovered} == {queued.job_id, running.job_id, deleting.job_id}
    assert store.has_active_job() is False
    for job_id in [queued.job_id, running.job_id, deleting.job_id]:
        job = store.get_job(job_id)
        assert job.status == "failed"
        assert job.progress == 100
        assert job.stage == "failed"
        assert job.delete_requested is False
        assert job.error == {
            "code": "service_restarted",
            "message": "Job was interrupted by service restart",
        }


def test_store_rejects_unsafe_job_ids_before_path_access(tmp_path):
    store = JobStore(tmp_path)

    with pytest.raises(JobIdError) as failure:
        store.get_job("../outside")

    assert failure.value.code == "invalid_job_id"
    assert not (tmp_path / "outside" / "job.json").exists()


def test_store_atomic_artifact_write_failure_does_not_mark_partial_success(tmp_path, monkeypatch):
    store = JobStore(tmp_path)
    job = store.create_job(url="https://video.example/atomic", countries=["argentina"], extra_keywords=[])
    original_replace = __import__("os").replace

    def fail_replace(source, destination):
        if getattr(destination, "name", "") == "summary.json":
            raise OSError("disk full")
        return original_replace(source, destination)

    monkeypatch.setattr("app.store.os.replace", fail_replace)

    with pytest.raises(ArtifactWriteError) as failure:
        store.save_summary(job.job_id, {"detected_language": "es", "items": []})

    assert failure.value.code == "artifact_write_failed"
    assert not (tmp_path / "jobs" / job.job_id / "summary.json").exists()
    assert store.get_job(job.job_id).artifacts["summary"] is False


def test_store_cleanup_removes_expired_generated_artifacts_but_preserves_history_metadata(tmp_path):
    store = JobStore(tmp_path)
    old_job = store.create_job(url="https://video.example/old", countries=["argentina"], extra_keywords=[])
    store.save_transcript(old_job.job_id, [TranscriptSegment(id="s1", start_ms=1000, end_ms=2000, text="Old output")])
    store.save_mentions(
        old_job.job_id,
        [
            MentionMatch(
                keyword="argentina",
                canonical="Argentina",
                segment_id="s1",
                start_ms=1000,
                end_ms=2000,
                text="Old output",
            )
        ],
    )
    store.save_summary(old_job.job_id, {"items": [{"label": "Argentina", "count": 1}]})
    store.save_export_text(old_job.job_id, "(00:01) Old output")
    (tmp_path / "jobs" / old_job.job_id / "source.mp4").write_text("downloaded media", encoding="utf-8")
    (tmp_path / "jobs" / old_job.job_id / "audio").mkdir()
    (tmp_path / "jobs" / old_job.job_id / "audio" / "audio-16khz.wav").write_text("audio", encoding="utf-8")
    store.mark_succeeded(old_job.job_id)
    old_timestamp = (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()
    old_record = store.get_job(old_job.job_id).model_dump(mode="json")
    old_record["updated_at"] = old_timestamp
    (tmp_path / "jobs" / old_job.job_id / "job.json").write_text(json.dumps(old_record), encoding="utf-8")

    removed = store.cleanup_expired_job_artifacts(ttl_seconds=7 * 24 * 60 * 60)

    assert removed == {old_job.job_id: ["audio", "export.txt", "mentions.json", "source.mp4", "summary.json", "transcript.json"]}
    assert (tmp_path / "jobs" / old_job.job_id / "job.json").exists()
    assert (tmp_path / "jobs" / "index.json").exists()
    assert store.list_history()[0].job_id == old_job.job_id
    assert store.list_history()[0].mention_count == 1
    assert store.get_transcript(old_job.job_id).segments == []
    assert not (tmp_path / "jobs" / old_job.job_id / "source.mp4").exists()
    assert not (tmp_path / "jobs" / old_job.job_id / "audio").exists()


def test_store_cleanup_preserves_active_fresh_and_non_runtime_files(tmp_path):
    store = JobStore(tmp_path / "runtime")
    old_active = store.create_job(url="https://video.example/active", countries=["argentina"], extra_keywords=[])
    store.mark_running(old_active.job_id)
    store.save_transcript(old_active.job_id, [TranscriptSegment(id="s1", start_ms=1000, end_ms=2000, text="Active output")])
    active_record = store.get_job(old_active.job_id).model_dump(mode="json")
    active_record["updated_at"] = (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()
    (tmp_path / "runtime" / "jobs" / old_active.job_id / "job.json").write_text(json.dumps(active_record), encoding="utf-8")

    fresh = store.create_job(url="https://video.example/fresh", countries=["colombia"], extra_keywords=[])
    store.save_export_text(fresh.job_id, "fresh export")
    store.mark_succeeded(fresh.job_id)
    fixture = tmp_path / "tests" / "fixtures" / "transcript.json"
    fixture.parent.mkdir(parents=True)
    fixture.write_text("fixture", encoding="utf-8")

    removed = store.cleanup_expired_job_artifacts(ttl_seconds=7 * 24 * 60 * 60)

    assert removed == {}
    assert (tmp_path / "runtime" / "jobs" / old_active.job_id / "transcript.json").exists()
    assert (tmp_path / "runtime" / "jobs" / fresh.job_id / "export.txt").exists()
    assert fixture.read_text(encoding="utf-8") == "fixture"


def test_store_cleanup_ttl_disabled_does_not_remove_runtime_artifacts(tmp_path):
    store = JobStore(tmp_path)
    job = store.create_job(url="https://video.example/old", countries=["argentina"], extra_keywords=[])
    store.save_export_text(job.job_id, "old export")
    store.mark_succeeded(job.job_id)
    old_record = store.get_job(job.job_id).model_dump(mode="json")
    old_record["updated_at"] = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    (tmp_path / "jobs" / job.job_id / "job.json").write_text(json.dumps(old_record), encoding="utf-8")

    assert store.cleanup_expired_job_artifacts(ttl_seconds=0) == {}
    assert (tmp_path / "jobs" / job.job_id / "export.txt").exists()


def test_store_cleanup_linked_artifacts_hard_deletes_by_job_url_and_video_id(tmp_path):
    store = JobStore(tmp_path)
    by_job = _completed_job_with_artifacts(store, url="https://video.example/watch?v=by-job")
    by_url = _completed_job_with_artifacts(store, url="https://www.youtube.com/watch?v=by-url")
    by_video_id = _completed_job_with_artifacts(store, url="https://youtu.be/by-video")
    active = store.create_job(url="https://www.youtube.com/watch?v=active", countries=["argentina"], extra_keywords=[])
    store.mark_running(active.job_id)
    store.save_export_text(active.job_id, "active export")

    result = store.cleanup_linked_artifacts(
        job_ids=[by_job.job_id, "00000000000000000000000000000000"],
        urls=["https://www.youtube.com/watch?v=by-url", "https://www.youtube.com/watch?v=missing"],
        video_ids=["by-video", "active"],
        mode="apply",
    )

    assert [item["job_id"] for item in result["deleted"]] == [by_job.job_id, by_url.job_id, by_video_id.job_id]
    assert result["missing"] == ["00000000000000000000000000000000", "https://www.youtube.com/watch?v=missing"]
    assert result["skipped_active"] == [active.job_id]
    assert result["errors"] == []
    for job in [by_job, by_url, by_video_id]:
        assert not (tmp_path / "jobs" / job.job_id).exists()
    assert (tmp_path / "jobs" / active.job_id / "export.txt").exists()
    assert [item.job_id for item in store.list_history()] == [active.job_id]

    idempotent = store.cleanup_linked_artifacts(job_ids=[by_job.job_id], urls=[], video_ids=[], mode="apply")

    assert idempotent["deleted"] == []
    assert idempotent["missing"] == [by_job.job_id]


def test_store_cleanup_linked_artifacts_dry_run_plans_without_deleting(tmp_path):
    store = JobStore(tmp_path)
    job = _completed_job_with_artifacts(store, url="https://www.youtube.com/watch?v=dry-run")

    result = store.cleanup_linked_artifacts(job_ids=[], urls=[], video_ids=["dry-run"], mode="dry-run")

    assert result["planned"] == [{"kind": "job_dir", "job_id": job.job_id, "url": "https://www.youtube.com/watch?v=dry-run"}]
    assert result["deleted"] == []
    assert result["missing"] == []
    assert (tmp_path / "jobs" / job.job_id / "export.txt").exists()
    assert store.list_history()[0].job_id == job.job_id


def _completed_job_with_artifacts(store: JobStore, *, url: str):
    job = store.create_job(url=url, countries=["argentina"], extra_keywords=[])
    store.save_transcript(job.job_id, [TranscriptSegment(id="s1", start_ms=1000, end_ms=2000, text="Artifact text")])
    store.save_mentions(job.job_id, [MentionMatch(keyword="argentina", canonical="Argentina", segment_id="s1", start_ms=1000, end_ms=2000, text="Artifact text")])
    store.save_summary(job.job_id, {"items": [{"label": "Argentina", "count": 1}]})
    store.save_export_text(job.job_id, "export")
    (store.jobs_dir / job.job_id / "source.mp4").write_text("media", encoding="utf-8")
    store.mark_succeeded(job.job_id)
    return job
