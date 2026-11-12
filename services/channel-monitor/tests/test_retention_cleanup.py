from __future__ import annotations

import sqlite3

from app.store import ChannelRecord, MonitorStore, TargetMatchRecord, VideoRecord
from app.workers import CleanupWorker


def test_detected_at_is_backfilled_and_preserved_on_video_upsert(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            create table videos (
                video_id text primary key,
                channel_id integer,
                title text,
                url text,
                published_at text,
                live_status text,
                lifecycle text not null,
                matched integer,
                match_reason text,
                evaluated_at text,
                next_poll_at text,
                classification_version text,
                classified_at text,
                classification_status text,
                classification_reason text,
                classification_run_id integer,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            insert into videos(video_id, title, lifecycle, created_at)
            values ('legacy', 'Legacy', 'ignored_seen', '2026-05-20T10:00:00Z');
            """
        )

    store = MonitorStore(db_path)
    store.migrate()
    legacy = store.get_video("legacy")
    store.upsert_video(legacy.with_updates(title="Legacy updated", detected_at="2026-05-25T10:00:00Z"))

    updated = store.get_video("legacy")
    assert legacy.detected_at == "2026-05-20T10:00:00Z"
    assert updated.detected_at == "2026-05-20T10:00:00Z"
    assert updated.title == "Legacy updated"


def test_dry_run_report_uses_detected_at_boundary_and_reports_all_channel_states_without_mutation(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    _seed_report_video(store, channel.id, video_id="older-radar", detected_at="2026-05-21T09:59:59Z", lifecycle="enqueued")
    _seed_report_video(store, channel.id, video_id="exact-boundary", detected_at="2026-05-21T10:00:00Z", lifecycle="ignored_seen")
    _seed_report_video(store, channel.id, video_id="younger", detected_at="2026-05-21T10:00:01Z", lifecycle="ignored_seen")

    before = _table_counts(store)
    report = store.build_retention_dry_run_report(cutoff="2026-05-21T10:00:00Z", limit=10)
    after = _table_counts(store)

    assert [item.video_id for item in report.items] == ["older-radar", "exact-boundary"]
    older = report.items[0]
    assert older.detected_at == "2026-05-21T09:59:59Z"
    assert older.url == "https://www.youtube.com/watch?v=older-radar"
    assert older.transcript_refs == {
        "radar_job_ids": ["job-older-radar", "match-job-older-radar"],
        "urls": ["https://www.youtube.com/watch?v=older-radar"],
        "video_ids": ["older-radar"],
    }
    assert older.planned_deletions == {
        "videos": 1,
        "enqueue_attempts": 1,
        "video_target_matches": 1,
        "rejected_videos": 1,
        "card_context_dismissals": 2,
        "transcript_artifacts": 0,
    }
    assert report.summary == {
        "mode": "dry-run",
        "cutoff": "2026-05-21T10:00:00Z",
        "video_count": 2,
        "planned_deletions": {
            "videos": 2,
            "enqueue_attempts": 2,
            "video_target_matches": 2,
            "rejected_videos": 2,
            "card_context_dismissals": 4,
            "transcript_artifacts": 0,
        },
    }
    assert store.get_video("younger") is not None
    assert before == after


def test_cleanup_worker_dry_run_adds_fake_transcript_artifact_plan_without_deleting_channel_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    _seed_report_video(store, channel.id, video_id="expired", detected_at="2026-05-21T09:00:00Z", lifecycle="enqueued")
    transcript = FakeTranscriptRetentionClient()
    before = _table_counts(store)

    report = CleanupWorker(
        store=store,
        now=lambda: "2026-05-26T10:00:00Z",
        retention_hours=120,
        mode="dry-run",
        transcript=transcript,
    ).run_retention_cleanup()

    assert transcript.calls == [
        {
            "mode": "dry-run",
            "job_ids": ["job-expired", "match-job-expired"],
            "urls": ["https://www.youtube.com/watch?v=expired"],
            "video_ids": ["expired"],
        }
    ]
    assert report.items[0].transcript_artifacts == [
        {"kind": "job_dir", "job_id": "job-expired"},
        {"kind": "video_index", "video_id": "expired"},
    ]
    assert report.items[0].planned_deletions["transcript_artifacts"] == 2
    assert store.get_video("expired") is not None
    assert _table_counts(store) == before


def test_cleanup_worker_default_retention_is_five_days_from_detected_at(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    _seed_report_video(store, channel.id, video_id="expired", detected_at="2026-05-21T10:00:00Z", lifecycle="enqueued")
    _seed_report_video(store, channel.id, video_id="active", detected_at="2026-05-21T10:00:01Z", lifecycle="enqueued")

    report = CleanupWorker(store=store, now=lambda: "2026-05-26T10:00:00Z").run_retention_cleanup()

    assert report.cutoff == "2026-05-21T10:00:00Z"
    assert [item.video_id for item in report.items] == ["expired"]
    assert store.get_video("expired") is not None
    assert store.get_video("active") is not None


def test_cleanup_preflight_reports_five_day_detected_video_policy(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()

    assert store.cleanup_preflight()["retention"] == "120h / 5 days from detected_at"
    assert not hasattr(store, "delete_old_non_actionable_videos")


def test_cleanup_worker_apply_deletes_transcript_first_then_channel_state_in_dependency_order(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    store.stamp_channel_baseline(channel.id, baseline_started_at="2026-05-20T12:00:00Z")
    store.advance_channel_catchup_checkpoint(
        channel.id,
        published_at="2026-05-21T12:00:00Z",
        caught_up_at="2026-05-21T12:05:00Z",
    )
    _seed_report_video(store, channel.id, video_id="expired", detected_at="2026-05-21T09:00:00Z", lifecycle="enqueued")
    _seed_report_video(store, channel.id, video_id="younger", detected_at="2026-05-21T10:00:01Z", lifecycle="ignored_seen")
    transcript = FakeTranscriptApplyClient()

    report = CleanupWorker(
        store=store,
        now=lambda: "2026-05-26T10:00:00Z",
        retention_hours=120,
        mode="apply",
        transcript=transcript,
    ).run_retention_cleanup()

    assert transcript.calls == [
        {
            "mode": "apply",
            "job_ids": ["job-expired", "match-job-expired"],
            "urls": ["https://www.youtube.com/watch?v=expired"],
            "video_ids": ["expired"],
        }
    ]
    assert report.summary["mode"] == "apply"
    assert report.summary["video_count"] == 1
    assert report.items[0].planned_deletions["videos"] == 1
    assert store.get_video("expired") is None
    assert store.get_video("younger") is not None
    updated_channel = store.find_channel_by_youtube_id("UCCaracol")
    assert updated_channel is not None
    assert updated_channel.baseline_started_at == "2026-05-20T12:00:00Z"
    assert updated_channel.last_seen_published_at == "2026-05-21T12:00:00Z"
    counts = _table_counts(store)
    assert counts == {
        "videos": 1,
        "enqueue_attempts": 1,
        "video_target_matches": 1,
        "rejected_videos": 1,
        "card_context_dismissals": 2,
        "cleanup_runs": 1,
    }
    assert store.list_cleanup_runs()[0].deleted_count == 1


def test_retention_cleanup_removes_card_context_dismissals_with_expired_video_state(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    _seed_report_video(store, channel.id, video_id="expired", detected_at="2026-05-21T09:00:00Z", lifecycle="enqueued")
    store.upsert_card_context_dismissal(surface="monitor-card", target_context="aurenia", video_id="expired", dismissed_at="2026-05-22T09:00:00Z")
    store.upsert_card_context_dismissal(surface="monitor-card", target_context="important", video_id="expired", dismissed_at="2026-05-22T09:00:00Z")

    report = CleanupWorker(
        store=store,
        now=lambda: "2026-05-26T10:00:00Z",
        retention_hours=120,
        mode="apply",
        transcript=FakeTranscriptApplyClient(),
    ).run_retention_cleanup()

    with sqlite3.connect(store.db_path) as connection:
        remaining = connection.execute("select count(*) from card_context_dismissals").fetchone()[0]

    assert report.items[0].planned_deletions["card_context_dismissals"] == 2
    assert remaining == 0
    assert store.get_video("expired") is None


def test_cleanup_worker_apply_preserves_channel_rows_when_transcript_cleanup_skips_active(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    _seed_report_video(store, channel.id, video_id="expired", detected_at="2026-05-21T09:00:00Z", lifecycle="enqueued")
    transcript = FakeTranscriptApplyClient(skipped_active=["job-expired"])
    before = _table_counts(store)

    report = CleanupWorker(
        store=store,
        now=lambda: "2026-05-26T10:00:00Z",
        retention_hours=120,
        mode="apply",
        transcript=transcript,
    ).run_retention_cleanup()

    assert report.summary["video_count"] == 1
    assert report.items[0].transcript_artifacts == [{"kind": "skipped_active", "job_id": "job-expired"}]
    assert store.get_video("expired") is not None
    assert _table_counts(store) == {**before, "cleanup_runs": 1}
    assert store.list_cleanup_runs()[0].deleted_count == 0
    assert "skipped_active" in store.list_cleanup_runs()[0].error


class FakeTranscriptRetentionClient:
    def __init__(self):
        self.calls: list[dict[str, object]] = []

    def plan_cleanup(self, *, job_ids: list[str], urls: list[str], video_ids: list[str], mode: str) -> dict[str, object]:
        self.calls.append({"mode": mode, "job_ids": job_ids, "urls": urls, "video_ids": video_ids})
        return {
            "planned": [
                {"kind": "job_dir", "job_id": job_ids[0]},
                {"kind": "video_index", "video_id": video_ids[0]},
            ]
        }


class FakeTranscriptApplyClient:
    def __init__(self, *, skipped_active: list[str] | None = None):
        self.calls: list[dict[str, object]] = []
        self.skipped_active = skipped_active or []

    def plan_cleanup(self, *, job_ids: list[str], urls: list[str], video_ids: list[str], mode: str) -> dict[str, object]:
        self.calls.append({"mode": mode, "job_ids": job_ids, "urls": urls, "video_ids": video_ids})
        if self.skipped_active:
            return {
                "deleted": [],
                "missing": [],
                "skipped_active": self.skipped_active,
                "errors": [],
            }
        return {
            "deleted": [{"kind": "job_dir", "job_id": job_id} for job_id in job_ids],
            "missing": [],
            "skipped_active": [],
            "errors": [],
        }


def _seed_report_video(store: MonitorStore, channel_id: int, *, video_id: str, detected_at: str, lifecycle: str) -> None:
    store.upsert_video(
        VideoRecord(
            video_id=video_id,
            channel_id=channel_id,
            title=f"Title {video_id}",
            url=f"https://www.youtube.com/watch?v={video_id}",
            lifecycle=lifecycle,
            detected_at=detected_at,
        )
    )
    store.record_enqueue_attempt(video_id=video_id, status="enqueued", radar_job_id=f"job-{video_id}")
    store.upsert_target_match(
        TargetMatchRecord(video_id=video_id, target_country="aurenia", status="transcribiendo", radar_job_id=f"match-job-{video_id}")
    )
    store.upsert_rejected_video(video_id=video_id, source_country="montelia", reason="no_valid_target_match")
    store.upsert_card_context_dismissal(surface="monitor-card", target_context="aurenia", video_id=video_id, dismissed_at=detected_at)
    store.upsert_card_context_dismissal(surface="monitor-card", target_context="important", video_id=video_id, dismissed_at=detected_at)


def _table_counts(store: MonitorStore) -> dict[str, int]:
    with sqlite3.connect(store.db_path) as connection:
        return {
            table: int(connection.execute(f"select count(*) from {table}").fetchone()[0])
            for table in [
                "videos",
                "enqueue_attempts",
                "video_target_matches",
                "rejected_videos",
                "card_context_dismissals",
                "cleanup_runs",
            ]
        }
