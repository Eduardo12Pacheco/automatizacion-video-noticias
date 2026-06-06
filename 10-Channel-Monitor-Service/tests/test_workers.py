from __future__ import annotations

import json

from app.boundary_client import BoundaryMetadataUnavailable, BoundaryRequestError
from app.settings import ImportantRule
from app.store import ChannelRecord, MonitorStore, VideoRecord
from app.opencode_go_client import OpenCodeGoError
from app.title_matcher import PlayerTerms, TARGET_COUNTRY_ORDER, TitleCatalog, TitleMatcher
from app.workers import (
    AiRescueWorker,
    CatchupWorker,
    ClassificationService,
    DiscoveryWorker,
    EnqueueWorker,
    ClassificationBackfill,
    TranscriptSyncWorker,
    WebSubRenewalWorker,
    accepts_foreign_press_match,
)
from app.youtube_client import MetadataUnavailable, SubtitleSegment, SubtitleUnavailable, UploadItem, VideoMetadata


class FakeYouTube:
    def __init__(self, metadata_by_id):
        self.metadata_by_id = metadata_by_id
        self.calls: list[str] = []

    def get_video_metadata(self, video_id: str):
        self.calls.append(video_id)
        value = self.metadata_by_id[video_id]
        if isinstance(value, Exception):
            raise value
        return value


class FakeUploadPlaylistClient:
    def __init__(self, uploads_by_playlist: dict[str, list[str]]):
        self.uploads_by_playlist = uploads_by_playlist
        self.calls: list[tuple[str, int]] = []

    def list_upload_video_ids(self, uploads_playlist_id: str, *, limit: int) -> list[str]:
        self.calls.append((uploads_playlist_id, limit))
        return self.uploads_by_playlist[uploads_playlist_id]

    def iter_upload_items(self, uploads_playlist_id: str, *, page_limit: int, item_limit: int):
        self.calls.append((uploads_playlist_id, item_limit))
        for value in self.uploads_by_playlist[uploads_playlist_id]:
            if isinstance(value, UploadItem):
                yield value
            else:
                yield UploadItem(video_id=value, published_at="2026-05-19T12:00:00Z")


class FakeRadarSubmitter:
    def __init__(self):
        self.calls: list[tuple[str, list[str]]] = []

    def submit_job(self, url: str, *, countries: list[str]):
        from app.radar_client import RadarJobResult

        self.calls.append((url, countries))
        return RadarJobResult(job_id=f"job-{len(self.calls)}", status="queued")


class BusyRadarSubmitter:
    def __init__(self):
        self.calls: list[tuple[str, list[str]]] = []

    def submit_job(self, url: str, *, countries: list[str]):
        from app.radar_client import RadarBusy

        self.calls.append((url, countries))
        raise RadarBusy("radar_busy")


class FakeRadarStatusClient:
    def __init__(self, *, detail_by_job_id: dict[str, dict], summary_by_job_id: dict[str, dict] | None = None):
        self.detail_by_job_id = detail_by_job_id
        self.summary_by_job_id = summary_by_job_id or {}
        self.calls: list[tuple[str, str]] = []

    def get_job_detail(self, job_id: str):
        self.calls.append(("detail", job_id))
        return self.detail_by_job_id[job_id]

    def get_job_summary(self, job_id: str):
        self.calls.append(("summary", job_id))
        return self.summary_by_job_id[job_id]


def make_store(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="fr", label="L'Équipe", source_url=None, youtube_channel_id="UCStable")
    )
    return store, channel


def test_discovery_worker_preserves_duplicate_terminal_state(tmp_path):
    store, channel = make_store(tmp_path)
    store.upsert_video(
        VideoRecord(
            video_id="seen-1",
            channel_id=channel.id,
            title="Old title",
            url="https://www.youtube.com/watch?v=seen-1",
            lifecycle="ignored_seen",
            live_status="none",
            matched=False,
            match_reason="[]",
            evaluated_at="2026-05-19T10:00:00Z",
        )
    )
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "seen-1": VideoMetadata(
                    video_id="seen-1",
                    channel_id="UCStable",
                    title="France now matches",
                    published_at="2026-05-19T11:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"fr": ["france"]}, players=[])),
    )

    result = worker.process_video_id("seen-1")

    assert result.lifecycle == "ignored_seen"
    assert result.title == "Old title"
    assert worker.youtube.calls == []


def test_discovery_worker_holds_active_live_and_does_not_evaluate_title(tmp_path):
    store, _channel = make_store(tmp_path)
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "live-1": VideoMetadata(
                    video_id="live-1",
                    channel_id="UCStable",
                    title="France live watchalong",
                    published_at="2026-05-19T10:00:00Z",
                    live_status="live",
                )
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"fr": ["france"]}, players=[])),
    )

    result = worker.process_video_id("live-1")

    assert result.lifecycle == "pending_live"
    assert result.matched is None
    assert result.evaluated_at is None


def test_discovery_worker_evaluates_completed_foreign_vod_once_and_marks_matching_candidate(tmp_path):
    store, _channel = make_store(tmp_path)
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "vod-1": VideoMetadata(
                    video_id="vod-1",
                    channel_id="UCStable",
                    title="Ecuador postgame reaction",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )

    first = worker.process_video_id("vod-1")
    second = worker.process_video_id("vod-1")

    assert first.lifecycle == "enqueue_pending"
    assert first.matched is True
    assert "ecuador" in (first.match_reason or "")
    assert second.lifecycle == "enqueue_pending"
    assert worker.youtube.calls == ["vod-1"]


def test_catchup_worker_processes_unseen_uploads_and_skips_known_before_metadata(tmp_path):
    store, channel = make_store(tmp_path)
    channel = store.upsert_channel(
        ChannelRecord(
            id=channel.id,
            country=channel.country,
            label=channel.label,
            source_url=channel.source_url,
            youtube_channel_id=channel.youtube_channel_id,
            uploads_playlist_id="UUStable",
            enabled=channel.enabled,
        )
    )
    store.upsert_video(VideoRecord(video_id="known-1", channel_id=channel.id, lifecycle="ignored_seen", matched=False))
    discovery = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "new-1": VideoMetadata(
                    video_id="new-1",
                    channel_id="UCStable",
                    title="Ecuador postgame",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )
    catchup = CatchupWorker(
        store=store,
        youtube=FakeUploadPlaylistClient({"UUStable": ["known-1", "new-1"]}),
        discovery=discovery,
        upload_limit=10,
    )

    results = catchup.run_once()

    assert [video.video_id for video in results] == ["new-1"]
    assert results[0].lifecycle == "enqueue_pending"
    assert discovery.youtube.calls == ["new-1"]
    assert catchup.youtube.calls == [("UUStable", 10)]


def test_pending_live_polling_rechecks_until_completed_then_evaluates_once(tmp_path):
    store, _channel = make_store(tmp_path)
    store.upsert_video(
        VideoRecord(video_id="live-2", channel_id=1, url="https://www.youtube.com/watch?v=live-2", lifecycle="pending_live")
    )
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "live-2": VideoMetadata(
                    video_id="live-2",
                    channel_id="UCStable",
                    title="No player here",
                    published_at="2026-05-19T09:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"fr": ["france"]}, players=[])),
    )

    results = worker.poll_pending_live()

    assert [video.lifecycle for video in results] == ["ignored_seen"]
    assert results[0].matched is False
    assert worker.youtube.calls == ["live-2"]


def test_pending_live_polling_records_dns_failure_and_continues_sibling_items(tmp_path):
    store, _channel = make_store(tmp_path)
    store.upsert_video(
        VideoRecord(video_id="live-dns", channel_id=1, url="https://www.youtube.com/watch?v=live-dns", lifecycle="pending_live")
    )
    store.upsert_video(
        VideoRecord(video_id="live-ok", channel_id=1, url="https://www.youtube.com/watch?v=live-ok", lifecycle="pending_live")
    )
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "live-dns": OSError("dns lookup failed"),
                "live-ok": VideoMetadata(
                    video_id="live-ok",
                    channel_id="UCStable",
                    title="Ecuador postgame reaction",
                    published_at="2026-05-19T09:00:00Z",
                    live_status="completed",
                ),
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )

    results = worker.poll_pending_live()

    assert [(video.video_id, video.lifecycle, video.match_reason) for video in results] == [
        ("live-dns", "metadata_failed", "item_processing_failed:OSError"),
        ("live-ok", "enqueue_pending", '[{"type": "country", "country": "ecuador", "term": "ecuador"}]'),
    ]
    assert worker.youtube.calls == ["live-dns", "live-ok"]


def test_catchup_worker_records_unexpected_item_failure_and_continues_sibling_items(tmp_path):
    store, channel = make_store(tmp_path)
    store.upsert_channel(
        ChannelRecord(
            id=channel.id,
            country=channel.country,
            label=channel.label,
            source_url=channel.source_url,
            youtube_channel_id=channel.youtube_channel_id,
            uploads_playlist_id="UUStable",
            enabled=channel.enabled,
        )
    )
    discovery = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "bad-item": RuntimeError("metadata parser exploded"),
                "good-item": VideoMetadata(
                    video_id="good-item",
                    channel_id="UCStable",
                    title="Ecuador postgame",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                ),
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )
    catchup = CatchupWorker(
        store=store,
        youtube=FakeUploadPlaylistClient({"UUStable": ["bad-item", "good-item"]}),
        discovery=discovery,
        upload_limit=10,
    )

    results = catchup.run_once()

    assert [(video.video_id, video.lifecycle, video.match_reason) for video in results] == [
        ("bad-item", "metadata_failed", "item_processing_failed:RuntimeError"),
        ("good-item", "enqueue_pending", '[{"type": "country", "country": "ecuador", "term": "ecuador"}]'),
    ]
    assert discovery.youtube.calls == ["bad-item", "good-item"]
    assert store.get_video("bad-item").matched is False


def test_catchup_worker_uses_baseline_to_skip_pre_baseline_history(tmp_path):
    store, channel = make_store(tmp_path)
    channel = store.upsert_channel(ChannelRecord(id=channel.id, country=channel.country, label=channel.label, source_url=channel.source_url, youtube_channel_id=channel.youtube_channel_id, uploads_playlist_id="UUStable", enabled=True))
    store.stamp_channel_baseline(channel.id, baseline_started_at="2026-05-28T20:00:00Z")
    discovery = DiscoveryWorker(store=store, youtube=FakeYouTube({}), matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])))
    catchup = CatchupWorker(store=store, youtube=FakeUploadPlaylistClient({"UUStable": [UploadItem(video_id="old", published_at="2026-05-28T19:59:59Z")]}), discovery=discovery, page_limit=2, item_limit=10)

    assert catchup.run_once() == []
    assert discovery.youtube.calls == []
    assert store.find_channel_by_youtube_id("UCStable").last_seen_published_at is None


def test_catchup_worker_resolves_missing_upload_timestamp_before_skipping_old_baseline_item(tmp_path):
    store, channel = make_store(tmp_path)
    channel = store.upsert_channel(ChannelRecord(id=channel.id, country=channel.country, label=channel.label, source_url=channel.source_url, youtube_channel_id=channel.youtube_channel_id, uploads_playlist_id="UUStable", enabled=True))
    store.stamp_channel_baseline(channel.id, baseline_started_at="2026-05-29T01:45:13Z")
    discovery = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube({
            "tz8m8h19vGc": VideoMetadata(video_id="tz8m8h19vGc", channel_id="UCStable", title="Old L'Équipe upload", published_at="2026-04-15T16:01:39Z", live_status="completed"),
        }),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )
    catchup = CatchupWorker(store=store, youtube=FakeUploadPlaylistClient({"UUStable": [UploadItem(video_id="tz8m8h19vGc", published_at=None)]}), discovery=discovery, page_limit=2, item_limit=10)

    results = catchup.run_once()

    assert results == []
    assert discovery.youtube.calls == ["tz8m8h19vGc"]
    assert store.get_video("tz8m8h19vGc") is None
    updated = store.find_channel_by_youtube_id("UCStable")
    assert updated.last_seen_published_at is None
    assert updated.last_catchup_error is None


def test_catchup_worker_processes_and_checkpoints_new_item_after_resolving_missing_upload_timestamp(tmp_path):
    store, channel = make_store(tmp_path)
    channel = store.upsert_channel(ChannelRecord(id=channel.id, country=channel.country, label=channel.label, source_url=channel.source_url, youtube_channel_id=channel.youtube_channel_id, uploads_playlist_id="UUStable", enabled=True))
    store.stamp_channel_baseline(channel.id, baseline_started_at="2026-05-29T01:45:13Z")
    discovery = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube({
            "new-missing-ts": VideoMetadata(video_id="new-missing-ts", channel_id="UCStable", title="Ecuador postgame", published_at="2026-05-29T01:46:00Z", live_status="completed"),
        }),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )
    catchup = CatchupWorker(
        store=store,
        youtube=FakeUploadPlaylistClient({
            "UUStable": [
                UploadItem(video_id="new-missing-ts", published_at=None),
                UploadItem(video_id="old", published_at="2026-05-29T01:45:12Z"),
            ]
        }),
        discovery=discovery,
        page_limit=2,
        item_limit=10,
    )

    results = catchup.run_once()

    assert [(video.video_id, video.lifecycle, video.published_at) for video in results] == [
        ("new-missing-ts", "enqueue_pending", "2026-05-29T01:46:00Z")
    ]
    assert discovery.youtube.calls == ["new-missing-ts"]
    updated = store.find_channel_by_youtube_id("UCStable")
    assert updated.last_seen_published_at == "2026-05-29T01:46:00Z"
    assert updated.last_catchup_error is None


def test_catchup_worker_records_error_without_checkpoint_or_terminal_video_when_missing_timestamp_metadata_unavailable(tmp_path):
    store, channel = make_store(tmp_path)
    channel = store.upsert_channel(ChannelRecord(id=channel.id, country=channel.country, label=channel.label, source_url=channel.source_url, youtube_channel_id=channel.youtube_channel_id, uploads_playlist_id="UUStable", enabled=True))
    store.stamp_channel_baseline(channel.id, baseline_started_at="2026-05-29T01:45:13Z")
    discovery = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube({"missing-meta": MetadataUnavailable("missing-meta")}),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )
    catchup = CatchupWorker(store=store, youtube=FakeUploadPlaylistClient({"UUStable": [UploadItem(video_id="missing-meta", published_at=None)]}), discovery=discovery, page_limit=2, item_limit=10)

    results = catchup.run_once()

    assert results == []
    assert discovery.youtube.calls == ["missing-meta"]
    assert store.get_video("missing-meta") is None
    updated = store.find_channel_by_youtube_id("UCStable")
    assert updated.last_seen_published_at is None
    assert updated.last_catchup_error == "metadata_unresolved:missing-meta"


def test_catchup_worker_paginates_known_ids_and_advances_checkpoint_after_safe_decisions(tmp_path):
    store, channel = make_store(tmp_path)
    channel = store.upsert_channel(ChannelRecord(id=channel.id, country=channel.country, label=channel.label, source_url=channel.source_url, youtube_channel_id=channel.youtube_channel_id, uploads_playlist_id="UUStable", enabled=True))
    store.stamp_channel_baseline(channel.id, baseline_started_at="2026-05-28T20:00:00Z")
    store.upsert_video(VideoRecord(video_id="known", channel_id=channel.id, lifecycle="ignored_seen", matched=False, published_at="2026-05-28T20:03:00Z"))
    discovery = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube({
            "new-1": VideoMetadata(video_id="new-1", channel_id="UCStable", title="Ecuador", published_at="2026-05-28T20:02:00Z", live_status="completed"),
            "new-2": VideoMetadata(video_id="new-2", channel_id="UCStable", title="Ecuador", published_at="2026-05-28T20:01:00Z", live_status="completed"),
        }),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )
    uploads = [
        UploadItem(video_id="known", published_at="2026-05-28T20:03:00Z"),
        UploadItem(video_id="new-1", published_at="2026-05-28T20:02:00Z"),
        UploadItem(video_id="new-2", published_at="2026-05-28T20:01:00Z"),
        UploadItem(video_id="old", published_at="2026-05-28T19:59:59Z"),
    ]
    catchup = CatchupWorker(store=store, youtube=FakeUploadPlaylistClient({"UUStable": uploads}), discovery=discovery, page_limit=3, item_limit=100)

    results = catchup.run_once()

    assert [video.video_id for video in results] == ["new-1", "new-2"]
    assert discovery.youtube.calls == ["new-1", "new-2"]
    assert store.find_channel_by_youtube_id("UCStable").last_seen_published_at == "2026-05-28T20:02:00Z"


def test_catchup_worker_does_not_advance_checkpoint_when_scan_is_truncated_before_floor(tmp_path):
    store, channel = make_store(tmp_path)
    channel = store.upsert_channel(ChannelRecord(id=channel.id, country=channel.country, label=channel.label, source_url=channel.source_url, youtube_channel_id=channel.youtube_channel_id, uploads_playlist_id="UUStable", enabled=True))
    store.stamp_channel_baseline(channel.id, baseline_started_at="2026-05-28T20:00:00Z")
    discovery = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube({
            "new-1": VideoMetadata(video_id="new-1", channel_id="UCStable", title="Ecuador", published_at="2026-05-28T20:02:00Z", live_status="completed"),
        }),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )
    uploads = [UploadItem(video_id="new-1", published_at="2026-05-28T20:02:00Z")]
    catchup = CatchupWorker(store=store, youtube=FakeUploadPlaylistClient({"UUStable": uploads}), discovery=discovery, page_limit=1, item_limit=1)

    results = catchup.run_once()

    assert [video.video_id for video in results] == ["new-1"]
    updated = store.find_channel_by_youtube_id("UCStable")
    assert updated.last_seen_published_at is None
    assert updated.last_catchup_error is None


def test_catchup_worker_processes_unseen_video_with_same_timestamp_as_checkpoint(tmp_path):
    store, channel = make_store(tmp_path)
    channel = store.upsert_channel(ChannelRecord(id=channel.id, country=channel.country, label=channel.label, source_url=channel.source_url, youtube_channel_id=channel.youtube_channel_id, uploads_playlist_id="UUStable", enabled=True))
    store.advance_channel_catchup_checkpoint(channel.id, published_at="2026-05-28T20:00:00Z", caught_up_at="2026-05-28T20:05:00Z")
    discovery = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube({
            "same-ts": VideoMetadata(video_id="same-ts", channel_id="UCStable", title="Ecuador", published_at="2026-05-28T20:00:00Z", live_status="completed"),
        }),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )
    uploads = [
        UploadItem(video_id="same-ts", published_at="2026-05-28T20:00:00Z"),
        UploadItem(video_id="old", published_at="2026-05-28T19:59:59Z"),
    ]
    catchup = CatchupWorker(store=store, youtube=FakeUploadPlaylistClient({"UUStable": uploads}), discovery=discovery, page_limit=2, item_limit=10)

    results = catchup.run_once()

    assert [(video.video_id, video.lifecycle) for video in results] == [("same-ts", "enqueue_pending")]
    assert discovery.youtube.calls == ["same-ts"]
    assert store.find_channel_by_youtube_id("UCStable").last_seen_published_at == "2026-05-28T20:00:00Z"


def test_catchup_worker_records_failed_upload_but_advances_for_later_processed_upload(tmp_path):
    store, channel = make_store(tmp_path)
    channel = store.upsert_channel(ChannelRecord(id=channel.id, country=channel.country, label=channel.label, source_url=channel.source_url, youtube_channel_id=channel.youtube_channel_id, uploads_playlist_id="UUStable", enabled=True))
    store.stamp_channel_baseline(channel.id, baseline_started_at="2026-05-28T20:00:00Z")
    discovery = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube({
            "bad": RuntimeError("boom"),
            "good": VideoMetadata(video_id="good", channel_id="UCStable", title="Ecuador", published_at="2026-05-28T20:02:00Z", live_status="completed"),
        }),
        matcher=TitleMatcher(TitleCatalog(countries={"ec": ["ecuador"]}, players=[])),
    )
    uploads = [
        UploadItem(video_id="good", published_at="2026-05-28T20:02:00Z"),
        UploadItem(video_id="bad", published_at="2026-05-28T20:01:00Z"),
        UploadItem(video_id="old", published_at="2026-05-28T19:59:59Z"),
    ]
    catchup = CatchupWorker(store=store, youtube=FakeUploadPlaylistClient({"UUStable": uploads}), discovery=discovery, page_limit=2, item_limit=10)

    results = catchup.run_once()

    assert [(video.video_id, video.lifecycle) for video in results] == [("good", "enqueue_pending"), ("bad", "metadata_failed")]
    updated = store.find_channel_by_youtube_id("UCStable")
    assert updated.last_seen_published_at == "2026-05-28T20:02:00Z"
    assert updated.last_catchup_error == "item_failed:bad"
    assert store.get_video("bad").match_reason == "item_processing_failed:RuntimeError"


def test_source_country_only_match_is_ignored_and_mixed_foreign_match_is_accepted(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(ChannelRecord(country="co", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "domestic": VideoMetadata(
                    video_id="domestic",
                    channel_id="UCCaracol",
                    title="Colombia: rueda de prensa de James Rodríguez",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                ),
                "mixed": VideoMetadata(
                    video_id="mixed",
                    channel_id="UCCaracol",
                    title="Ecuador - Colombia análisis post partido",
                    published_at="2026-05-19T13:00:00Z",
                    live_status="completed",
                ),
            }
        ),
        matcher=TitleMatcher(
            TitleCatalog(
                countries={"co": ["colombia"], "ec": ["ecuador"]},
                players=[PlayerTerms(name="James Rodríguez", country="co", aliases=["james rodriguez"])],
            )
        ),
    )

    domestic = worker.process_video_id("domestic")
    mixed = worker.process_video_id("mixed")

    assert accepts_foreign_press_match([{"country": "co"}], source_country="co") is False
    assert domestic.lifecycle == "ignored_seen"
    assert domestic.matched is False
    assert mixed.lifecycle == "enqueue_pending"
    assert mixed.matched is True


def test_discovery_worker_creates_target_rows_for_every_non_source_match_and_rejects_domestic_only(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "domestic": VideoMetadata(
                    video_id="domestic",
                    channel_id="UCCaracol",
                    title="James habla de Colombia",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                ),
                "multi": VideoMetadata(
                    video_id="multi",
                    channel_id="UCCaracol",
                    title="Ecuador y México miran a Colombia",
                    published_at="2026-05-19T13:00:00Z",
                    live_status="completed",
                ),
            }
        ),
        matcher=TitleMatcher(
            TitleCatalog(countries={"colombia": ["colombia"], "ecuador": ["ecuador"], "mexico": ["mexico"]}, players=[])
        ),
    )

    domestic = worker.process_video_id("domestic")
    multi = worker.process_video_id("multi")

    assert domestic.lifecycle == "ignored_seen"
    assert store.list_rejected_videos(limit=10).items[0].video_id == "domestic"
    assert multi.lifecycle == "enqueue_pending"
    assert [(match.target_country, match.status) for match in store.list_target_matches(video_id="multi")] == [
        ("ecuador", "aprobado"),
        ("mexico", "aprobado"),
    ]


def test_discovery_worker_does_not_enqueue_new_rejections_when_ai_rescue_is_disabled(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "domestic": VideoMetadata(
                    video_id="domestic",
                    channel_id="UCCaracol",
                    title="James habla de Colombia",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(
            TitleCatalog(
                countries={"colombia": ["colombia"]},
                players=[PlayerTerms(name="James", country="colombia", aliases=["james"])],
            )
        ),
        ai_rescue_enabled=False,
    )

    result = worker.process_video_id("domestic")

    assert result.lifecycle == "ignored_seen"
    assert store.list_rejected_videos(limit=10).items[0].video_id == "domestic"
    assert store.list_ai_rescue_queue(limit=10) == []


def test_discovery_worker_marks_important_title_mismatch_enqueue_pending_without_target_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports",
            source_url=None,
            youtube_channel_id="UCImportant",
            important=True,
            priority_tier="importantes",
        )
    )
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "important-mismatch": VideoMetadata(
                    video_id="important-mismatch",
                    channel_id="UCImportant",
                    title="Mercado europeo sin menciones locales",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"ecuador": ["ecuador"]}, players=[])),
        ai_rescue_enabled=True,
        now=lambda: "2026-05-22T11:00:00Z",
    )

    result = worker.process_video_id("important-mismatch")

    assert result.lifecycle == "enqueue_pending"
    assert result.matched is True
    assert result.classification_status == "important_channel"
    assert result.classification_reason == "important_channel_all_countries"
    assert [item.video_id for item in store.list_rejected_videos(limit=10).items] == []
    assert store.list_ai_rescue_queue(limit=10) == []
    assert store.list_target_matches(video_id="important-mismatch") == []


def test_discovery_worker_marks_full_channel_mode_important_without_country_target_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports",
            source_url=None,
            youtube_channel_id="UCFullImportant",
            important_mode="full_channel",
        )
    )
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "full-important": VideoMetadata(
                    video_id="full-important",
                    channel_id="UCFullImportant",
                    title="Any completed VOD without country keywords",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"ecuador": ["ecuador"]}, players=[])),
        now=lambda: "2026-05-22T11:00:00Z",
    )

    result = worker.process_video_id("full-important")

    assert result.lifecycle == "enqueue_pending"
    assert result.matched is True
    assert result.classification_status == "important"
    assert result.classification_reason == "important_full_channel"
    assert json.loads(result.match_reason or "[]") == [
        {"type": "important_full_channel", "label": "NSports", "source_country": "argentina"}
    ]
    assert result.classification_version == "title-country-v1"
    assert result.classified_at == "2026-05-22T11:00:00Z"
    assert store.list_target_matches(video_id="full-important") == []
    assert store.list_rejected_videos(limit=10).items == []


def test_discovery_worker_marks_matching_program_rule_important_without_marking_whole_channel(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(
        ChannelRecord(
            country="peru",
            label="Mr Peet",
            source_url=None,
            youtube_channel_id="UCMrPeet",
            important_mode="program_rules",
            important_rules=[ImportantRule(content_types=["live", "completed"], op="starts_with", value="MADRUGOL CON MR PEET")],
        )
    )
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "program-important": VideoMetadata(
                    video_id="program-important",
                    channel_id="UCMrPeet",
                    title="Madrugol con Mr Peet: previa internacional",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                ),
                "program-nonmatch": VideoMetadata(
                    video_id="program-nonmatch",
                    channel_id="UCMrPeet",
                    title="Entrevista a Perú sin programa",
                    published_at="2026-05-19T13:00:00Z",
                    live_status="completed",
                ),
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"peru": ["peru"]}, players=[])),
        now=lambda: "2026-05-22T11:00:00Z",
    )

    important = worker.process_video_id("program-important")
    nonmatch = worker.process_video_id("program-nonmatch")

    assert important.lifecycle == "enqueue_pending"
    assert important.matched is True
    assert important.classification_status == "important"
    assert important.classification_reason == "important_program_rule"
    assert json.loads(important.match_reason or "[]") == [
        {
            "type": "important_program_rule",
            "label": "Mr Peet",
            "source_country": "peru",
            "op": "starts_with",
            "value": "MADRUGOL CON MR PEET",
            "normalized_value": "madrugol con mr peet",
            "normalized_title": "madrugol con mr peet previa internacional",
        }
    ]
    assert store.list_target_matches(video_id="program-important") == []
    assert nonmatch.lifecycle == "ignored_seen"
    assert nonmatch.matched is False
    assert nonmatch.classification_status == "rejected"
    assert nonmatch.classification_reason == "no_valid_target_match"


def test_discovery_worker_continues_normal_country_path_for_mixed_channel_nonmatch(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(
        ChannelRecord(
            country="mexico",
            label="MARCA",
            source_url=None,
            youtube_channel_id="UCMarca",
            important_mode="program_rules",
            important_rules=[ImportantRule(content_types=["completed"], op="starts_with", value="LA PIZARRA DE QUINTANA")],
        )
    )
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "mixed-country": VideoMetadata(
                    video_id="mixed-country",
                    channel_id="UCMarca",
                    title="Ecuador analiza mercado de fichajes",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"ecuador": ["ecuador"], "mexico": ["mexico"]}, players=[])),
        now=lambda: "2026-05-22T11:00:00Z",
    )

    result = worker.process_video_id("mixed-country")

    assert result.lifecycle == "enqueue_pending"
    assert result.matched is True
    assert result.classification_status == "approved"
    assert result.classification_reason == "target_match"
    assert [(match.target_country, match.status) for match in store.list_target_matches(video_id="mixed-country")] == [
        ("ecuador", "aprobado")
    ]
    assert store.list_rejected_videos(limit=10).items == []


def test_discovery_worker_keeps_important_live_pending_until_completed_then_evaluates(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(
        ChannelRecord(
            country="chile",
            label="ADN Chile",
            source_url=None,
            youtube_channel_id="UCAdnChile",
            important_mode="program_rules",
            important_rules=[ImportantRule(content_types=["live", "completed"], op="contains", value="TENORES")],
        )
    )
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "pending-program": VideoMetadata(
                    video_id="pending-program",
                    channel_id="UCAdnChile",
                    title="Los Tenores en vivo",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="live",
                ),
                "completed-program": VideoMetadata(
                    video_id="completed-program",
                    channel_id="UCAdnChile",
                    title="Los Tenores resumen final",
                    published_at="2026-05-19T13:00:00Z",
                    live_status="completed",
                ),
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"chile": ["chile"]}, players=[])),
        now=lambda: "2026-05-22T11:00:00Z",
    )

    pending = worker.process_video_id("pending-program")
    completed = worker.process_video_id("completed-program")

    assert pending.lifecycle == "pending_live"
    assert pending.matched is None
    assert pending.evaluated_at is None
    assert pending.classification_status is None
    assert store.list_target_matches(video_id="pending-program") == []
    assert completed.lifecycle == "enqueue_pending"
    assert completed.matched is True
    assert completed.classification_status == "important"
    assert completed.classification_reason == "important_program_rule"
    assert store.list_target_matches(video_id="completed-program") == []


def test_enqueue_worker_submits_important_channel_without_target_rows_to_all_real_countries(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports",
            source_url=None,
            youtube_channel_id="UCImportant",
            important=True,
            priority_tier="importantes",
        )
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-ready",
            channel_id=channel.id,
            title="Mercado europeo sin menciones locales",
            url="https://youtu.be/important-ready",
            lifecycle="enqueue_pending",
            matched=True,
            match_reason='[{"type":"important_channel","country":"ecuador"},{"type":"important_channel","country":"colombia"},{"type":"important_channel","country":"argentina"},{"type":"important_channel","country":"uruguay"},{"type":"important_channel","country":"paraguay"},{"type":"important_channel","country":"mexico"}]',
            classification_status="important_channel",
        )
    )
    radar = FakeRadarSubmitter()

    results = EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-20T10:00:00Z").enqueue_due()

    assert [video.video_id for video in results] == ["important-ready"]
    assert radar.calls == [("https://youtu.be/important-ready", list(TARGET_COUNTRY_ORDER))]
    assert store.list_target_matches(video_id="important-ready") == []
    assert store.list_enqueue_attempts("important-ready")[-1].radar_job_id == "job-1"


def test_enqueue_worker_submits_important_full_channel_to_all_target_countries(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports",
            source_url=None,
            youtube_channel_id="UCImportantFull",
            important=True,
            important_mode="full_channel",
            priority_tier="importantes",
        )
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-full-ready",
            channel_id=channel.id,
            title="Mercado europeo sin menciones locales",
            url="https://youtu.be/important-full-ready",
            lifecycle="enqueue_pending",
            matched=True,
            match_reason='[{"type":"important_full_channel","label":"NSports","source_country":"argentina"}]',
            classification_status="important",
            important_mode="full_channel",
            queue_priority_tier="important",
            queue_priority_rank=0,
        )
    )
    radar = FakeRadarSubmitter()

    results = EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-20T10:00:00Z").enqueue_due()

    assert [video.video_id for video in results] == ["important-full-ready"]
    assert radar.calls == [("https://youtu.be/important-full-ready", list(TARGET_COUNTRY_ORDER))]
    assert store.list_enqueue_attempts("important-full-ready")[-1].radar_job_id == "job-1"


def test_enqueue_worker_submits_important_program_rule_to_all_target_countries(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="peru",
            label="Mr Peet",
            source_url=None,
            youtube_channel_id="UCMrPeet",
            important_mode="program_rules",
            important_rules=[ImportantRule(content_types=["completed"], op="starts_with", value="MADRUGOL CON MR PEET")],
        )
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-program-ready",
            channel_id=channel.id,
            title="MADRUGOL CON MR PEET - previa internacional",
            url="https://youtu.be/important-program-ready",
            lifecycle="enqueue_pending",
            matched=True,
            match_reason='[{"type":"important_program_rule","label":"Mr Peet","source_country":"peru","op":"starts_with","value":"MADRUGOL CON MR PEET"}]',
            classification_status="important",
            important_mode="program_rules",
            queue_priority_tier="important",
            queue_priority_rank=0,
        )
    )
    radar = FakeRadarSubmitter()

    results = EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-20T10:00:00Z").enqueue_due()

    assert [video.video_id for video in results] == ["important-program-ready"]
    assert radar.calls == [("https://youtu.be/important-program-ready", list(TARGET_COUNTRY_ORDER))]
    assert store.list_target_matches(video_id="important-program-ready") == []
    assert store.list_enqueue_attempts("important-program-ready")[-1].radar_job_id == "job-1"


def test_discovery_worker_keeps_non_important_title_mismatch_rejected(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(ChannelRecord(country="argentina", label="Normal", source_url=None, youtube_channel_id="UCNormal"))
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "normal-mismatch": VideoMetadata(
                    video_id="normal-mismatch",
                    channel_id="UCNormal",
                    title="Mercado europeo sin menciones locales",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(TitleCatalog(countries={"ecuador": ["ecuador"]}, players=[])),
    )

    result = worker.process_video_id("normal-mismatch")

    assert result.lifecycle == "ignored_seen"
    assert result.matched is False
    assert result.classification_status == "rejected"
    assert [(item.video_id, item.reason) for item in store.list_rejected_videos(limit=10).items] == [
        ("normal-mismatch", "no_title_match")
    ]


def test_discovery_worker_does_not_enqueue_rejections_even_if_ai_rescue_is_requested(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(ChannelRecord(country="mexico", label="Canal MX", source_url=None, youtube_channel_id="UCMX"))
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "domestic": VideoMetadata(
                    video_id="domestic",
                    channel_id="UCMX",
                    title="México analiza a Santiago Giménez",
                    published_at="2026-05-19T12:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(
            TitleCatalog(
                countries={"mexico": ["méxico"]},
                players=[PlayerTerms(name="Santiago Giménez", country="mexico", aliases=["santiago gimenez"])],
            )
        ),
        ai_rescue_enabled=True,
        now=lambda: "2026-05-22T11:00:00Z",
    )

    first = worker.process_video_id("domestic")
    second = worker.process_video_id("domestic")

    queue = store.list_ai_rescue_queue(limit=10)
    assert first.video_id == second.video_id == "domestic"
    assert queue == []


def test_classification_service_returns_foreign_targets_and_rejects_domestic_only_with_versioned_reason():
    classifier = ClassificationService(
        matcher=TitleMatcher(
            TitleCatalog(
                countries={"colombia": ["colombia"], "ecuador": ["ecuador"]},
                players=[PlayerTerms(name="James Rodríguez", country="colombia", aliases=["james rodriguez"])],
            )
        ),
        classification_version="title-country-v1",
    )

    foreign = classifier.classify(title="Ecuador y Colombia en análisis", source_country="colombia")
    domestic = classifier.classify(title="James Rodríguez habla de Colombia", source_country="colombia")

    assert foreign.target_countries == ["ecuador"]
    assert foreign.status == "approved"
    assert foreign.reason == "target_match"
    assert foreign.classification_version == "title-country-v1"
    assert domestic.target_countries == []
    assert domestic.status == "rejected"
    assert domestic.reason == "no_valid_target_match"


def test_backfill_dry_run_reports_without_writes_and_apply_is_classification_only_idempotent(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    store.upsert_video(VideoRecord(video_id="stale", channel_id=channel.id, title="Ecuador mira a Colombia", lifecycle="ignored_seen"))
    classifier = ClassificationService(
        matcher=TitleMatcher(TitleCatalog(countries={"colombia": ["colombia"], "ecuador": ["ecuador"]}, players=[])),
        classification_version="title-country-v1",
    )
    backfill = ClassificationBackfill(store=store, classifier=classifier, now=lambda: "2026-05-22T10:00:00Z")

    dry_run = backfill.run(mode="dry-run", limit=10)
    before_matches = store.list_target_matches(video_id="stale")
    apply_once = backfill.run(mode="apply", limit=10)
    apply_twice = backfill.run(mode="apply", limit=10)

    assert dry_run.candidate_count == 1
    assert dry_run.would_create_matches == 1
    assert before_matches == []
    assert apply_once.created_or_updated_matches == 1
    assert apply_once.created_or_updated_rejections == 0
    assert apply_twice.candidate_count == 0
    assert store.get_video("stale").lifecycle == "ignored_seen"
    assert store.list_enqueue_attempts("stale") == []
    assert [(match.target_country, match.status) for match in store.list_target_matches(video_id="stale")] == [("ecuador", "aprobado")]


def test_duplicate_discovery_preserves_existing_target_and_rejected_state(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube(
            {
                "multi": VideoMetadata(
                    video_id="multi",
                    channel_id="UCCaracol",
                    title="Ecuador y México miran a Colombia",
                    published_at="2026-05-19T13:00:00Z",
                    live_status="completed",
                )
            }
        ),
        matcher=TitleMatcher(
            TitleCatalog(countries={"colombia": ["colombia"], "ecuador": ["ecuador"], "mexico": ["mexico"]}, players=[])
        ),
    )

    first = worker.process_video_id("multi")
    store.upsert_target_match(store.list_target_matches(video_id="multi")[0].with_updates(status="transcribiendo"))
    second = worker.process_video_id("multi")

    assert first.video_id == second.video_id
    assert worker.youtube.calls == ["multi"]
    assert [(match.target_country, match.status) for match in store.list_target_matches(video_id="multi")] == [
        ("ecuador", "transcribiendo"),
        ("mexico", "aprobado"),
    ]


def test_enqueue_worker_does_not_submit_normal_title_matches(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="basura", channel_id=channel.id, title="Solo Colombia", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="basura", source_country="colombia", reason="no_valid_target_match")
    store.upsert_video(
        VideoRecord(video_id="mexico-video", channel_id=channel.id, title="México", url="https://youtu.be/mx", lifecycle="enqueue_pending", matched=True)
    )
    store.upsert_target_match(
        store.make_target_match(video_id="mexico-video", target_country="mexico", status="aprobado")
    )
    store.upsert_video(
        VideoRecord(video_id="ecuador-video", channel_id=channel.id, title="Ecuador", url="https://youtu.be/ec", lifecycle="enqueue_pending", matched=True)
    )
    store.upsert_target_match(
        store.make_target_match(video_id="ecuador-video", target_country="ecuador", status="aprobado")
    )
    radar = FakeRadarSubmitter()

    results = EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-20T10:00:00Z").enqueue_due()

    assert results == []
    assert radar.calls == []
    assert store.list_target_matches(video_id="ecuador-video")[0].status == "aprobado"
    assert store.list_target_matches(video_id="mexico-video")[0].status == "aprobado"


def test_enqueue_worker_does_not_submit_while_any_target_match_is_transcribing(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="running", channel_id=channel.id, title="Ecuador", lifecycle="enqueued", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="running", target_country="ecuador", status="transcribiendo"))
    store.upsert_video(
        VideoRecord(
            video_id="ready-next",
            channel_id=channel.id,
            title="México",
            url="https://youtu.be/ready-next",
            lifecycle="enqueue_pending",
            matched=True,
        )
    )
    store.upsert_target_match(store.make_target_match(video_id="ready-next", target_country="mexico", status="aprobado"))
    radar = FakeRadarSubmitter()

    results = EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-20T10:00:00Z").enqueue_due()

    assert results == []
    assert radar.calls == []
    assert store.list_target_matches(video_id="ready-next")[0].status == "aprobado"


def test_enqueue_worker_does_not_submit_while_important_mode_job_is_active(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    important_channel = store.upsert_channel(
        ChannelRecord(country="peru", label="Mr Peet", source_url=None, youtube_channel_id="UCImportant", important_mode="program_rules")
    )
    normal_channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-running",
            channel_id=important_channel.id,
            title="Madrugol",
            lifecycle="enqueued",
            matched=True,
            important_mode="program_rules",
            queue_priority_tier="important",
            queue_priority_rank=0,
        )
    )
    store.record_enqueue_attempt(video_id="important-running", status="enqueued", radar_job_id="job-important")
    store.upsert_video(
        VideoRecord(
            video_id="ready-next",
            channel_id=normal_channel.id,
            title="Ecuador",
            url="https://youtu.be/ready-next",
            lifecycle="enqueue_pending",
            matched=True,
        )
    )
    store.upsert_target_match(store.make_target_match(video_id="ready-next", target_country="ecuador", status="aprobado"))
    radar = FakeRadarSubmitter()

    results = EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-20T10:00:00Z").enqueue_due()

    assert results == []
    assert radar.calls == []
    assert store.list_target_matches(video_id="ready-next")[0].status == "aprobado"


def test_enqueue_worker_reuses_one_radar_job_for_all_targets_on_same_video(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="multi-target",
            channel_id=channel.id,
            title="Ecuador y México",
            url="https://youtu.be/multi-target",
            lifecycle="enqueue_pending",
            matched=True,
            classification_status="important",
            important_mode="program_rules",
            queue_priority_tier="important",
            queue_priority_rank=0,
        )
    )
    store.upsert_target_match(store.make_target_match(video_id="multi-target", target_country="mexico", status="aprobado"))
    store.upsert_target_match(store.make_target_match(video_id="multi-target", target_country="ecuador", status="aprobado"))
    radar = FakeRadarSubmitter()

    results = EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-20T10:00:00Z").enqueue_due()

    assert [video.video_id for video in results] == ["multi-target"]
    assert radar.calls == [("https://youtu.be/multi-target", ["ecuador", "mexico"])]
    assert [(match.target_country, match.status, match.radar_job_id) for match in store.list_target_matches(video_id="multi-target")] == [
        ("ecuador", "transcribiendo", "job-1"),
        ("mexico", "transcribiendo", "job-1"),
    ]


def test_enqueue_worker_records_queue_priority_audit_on_country_job_attempt(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="spain", label="Priority", source_url=None, youtube_channel_id="UCPriority", algorithm_priority_rank=3)
    )
    store.upsert_video(
        VideoRecord(
            video_id="priority-country",
            channel_id=channel.id,
            title="Ecuador",
            url="https://youtu.be/priority-country",
            lifecycle="enqueue_pending",
            matched=True,
            classification_status="important",
            important_mode="program_rules",
        )
    )
    store.upsert_target_match(store.make_target_match(video_id="priority-country", target_country="ecuador", status="aprobado"))
    radar = FakeRadarSubmitter()

    EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-20T10:00:00Z").enqueue_due()

    match = store.list_target_matches(video_id="priority-country")[0]
    attempt = store.list_enqueue_attempts("priority-country")[0]
    assert match.queue_priority_tier == "ecuador:algorithm_priority"
    assert match.queue_priority_rank == 1
    assert attempt.queue_priority_tier == "ecuador:algorithm_priority"
    assert attempt.queue_priority_rank == 1


def test_enqueue_worker_keeps_approved_targets_retryable_when_radar_is_busy(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="retry-me",
            channel_id=channel.id,
            title="Ecuador",
            url="https://youtu.be/retry-me",
            lifecycle="enqueue_pending",
            matched=True,
            classification_status="important",
            important_mode="program_rules",
        )
    )
    store.upsert_target_match(store.make_target_match(video_id="retry-me", target_country="ecuador", status="aprobado"))
    radar = BusyRadarSubmitter()

    results = EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-20T10:00:00Z").enqueue_due()

    assert [video.video_id for video in results] == ["retry-me"]
    assert radar.calls == [("https://youtu.be/retry-me", ["ecuador"])]
    assert [(match.target_country, match.status, match.radar_job_id) for match in store.list_target_matches(video_id="retry-me")] == [
        ("ecuador", "aprobado", None)
    ]
    assert store.list_enqueue_attempts("retry-me")[-1].next_attempt_at == "2026-05-20T10:05:00Z"


def test_transcript_sync_worker_scopes_completed_summary_to_each_existing_target_country(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="mexico", label="TUDN", source_url=None, youtube_channel_id="UCTudn")
    )
    store.upsert_video(VideoRecord(video_id="multi", channel_id=channel.id, title="Ecuador y Colombia", lifecycle="enqueued", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="multi", target_country="ecuador", status="transcribiendo", radar_job_id="job-1"))
    store.upsert_target_match(store.make_target_match(video_id="multi", target_country="colombia", status="transcribiendo", radar_job_id="job-1"))
    radar = FakeRadarStatusClient(
        detail_by_job_id={"job-1": {"job_id": "job-1", "status": "succeeded"}},
        summary_by_job_id={
            "job-1": {
                "items": [
                    {"country": "colombia", "label": "Colombia", "count": 2},
                    {"country": "colombia", "label": "James Rodríguez", "count": 1},
                    {"country": "ecuador", "label": "Gonzalo Plata", "count": 0},
                ]
            }
        },
    )

    synced = TranscriptSyncWorker(store=store, radar=radar).sync_once()

    assert synced == ["multi"]
    assert radar.calls == [("detail", "job-1"), ("summary", "job-1")]
    assert [(match.target_country, match.status, match.mention_counts_json) for match in store.list_target_matches(video_id="multi")] == [
        ("ecuador", "transcrito", "[]"),
        ("colombia", "transcrito", '[{"label":"Colombia","count":2},{"label":"James Rodríguez","count":1}]'),
    ]


def test_transcript_sync_worker_creates_transcript_discovered_country_without_zero_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="mexico", label="TUDN", source_url=None, youtube_channel_id="UCTudn")
    )
    store.upsert_video(VideoRecord(video_id="discover", channel_id=channel.id, title="COPA PLATA", lifecycle="enqueued", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="discover", target_country="ecuador", status="transcribiendo", radar_job_id="job-discover"))
    radar = FakeRadarStatusClient(
        detail_by_job_id={"job-discover": {"job_id": "job-discover", "status": "succeeded"}},
        summary_by_job_id={
            "job-discover": {
                "items": [
                    {"country": "uruguay", "label": "Uruguay", "count": 3},
                    {"country": "argentina", "label": "Argentina", "count": 0},
                ]
            }
        },
    )

    synced = TranscriptSyncWorker(store=store, radar=radar).sync_once()

    assert synced == ["discover"]
    assert [
        (match.target_country, match.status, match.approval_source, match.mention_counts_json)
        for match in store.list_target_matches(video_id="discover")
    ] == [
        ("ecuador", "transcrito", "title_classifier", "[]"),
        ("uruguay", "transcrito", "transcript_summary", '[{"label":"Uruguay","count":3}]'),
    ]


def test_transcript_sync_worker_terminal_sync_does_not_enqueue_normal_due_match(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="done", channel_id=channel.id, title="Ecuador", lifecycle="enqueued", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="done", target_country="ecuador", status="transcribiendo", radar_job_id="job-done"))
    store.upsert_video(
        VideoRecord(video_id="ready-next", channel_id=channel.id, title="México", url="https://youtu.be/ready-next", lifecycle="enqueue_pending", matched=True)
    )
    store.upsert_target_match(store.make_target_match(video_id="ready-next", target_country="mexico", status="aprobado"))
    sync_radar = FakeRadarStatusClient(
        detail_by_job_id={"job-done": {"job_id": "job-done", "status": "succeeded"}},
        summary_by_job_id={"job-done": {"items": [{"label": "Ecuador", "count": 1}]}},
    )
    enqueue_radar = FakeRadarSubmitter()
    enqueue_worker = EnqueueWorker(store=store, radar=enqueue_radar, now=lambda: "2026-05-20T10:00:00Z")

    synced = TranscriptSyncWorker(store=store, radar=sync_radar, enqueue_due=enqueue_worker.enqueue_due).sync_once()

    assert synced == ["done"]
    assert enqueue_radar.calls == []
    assert store.list_target_matches(video_id="ready-next")[0].status == "aprobado"


def test_transcript_sync_worker_marks_important_enqueue_attempt_terminal_with_existing_target_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    important_channel = store.upsert_channel(
        ChannelRecord(country="argentina", label="NSports", source_url=None, youtube_channel_id="UCImportant", important=True)
    )
    normal_channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-done",
            channel_id=important_channel.id,
            title="Ecuador",
            lifecycle="enqueued",
            matched=True,
            classification_status="important_channel",
        )
    )
    store.upsert_target_match(
        store.make_target_match(video_id="important-done", target_country="ecuador", status="transcribiendo", radar_job_id="job-important")
    )
    store.record_enqueue_attempt(video_id="important-done", status="enqueued", radar_job_id="job-important")
    store.upsert_video(
        VideoRecord(
            video_id="ready-after-important",
            channel_id=normal_channel.id,
            title="México",
            url="https://youtu.be/ready-after-important",
            lifecycle="enqueue_pending",
            matched=True,
        )
    )
    store.upsert_target_match(store.make_target_match(video_id="ready-after-important", target_country="mexico", status="aprobado"))
    sync_radar = FakeRadarStatusClient(
        detail_by_job_id={"job-important": {"job_id": "job-important", "status": "succeeded"}},
        summary_by_job_id={"job-important": {"items": [{"country": "ecuador", "label": "Ecuador", "count": 1}]}},
    )
    enqueue_radar = FakeRadarSubmitter()
    enqueue_worker = EnqueueWorker(store=store, radar=enqueue_radar, now=lambda: "2026-05-20T10:00:00Z")

    synced = TranscriptSyncWorker(store=store, radar=sync_radar, enqueue_due=enqueue_worker.enqueue_due).sync_once()

    assert synced == ["important-done"]
    assert store.list_enqueue_attempts("important-done")[-1].status == "transcrito"
    assert enqueue_radar.calls == []
    assert store.list_target_matches(video_id="ready-after-important")[0].status == "aprobado"


def test_transcript_sync_worker_non_terminal_sync_does_not_trigger_immediate_enqueue(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="running", channel_id=channel.id, title="Ecuador", lifecycle="enqueued", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="running", target_country="ecuador", status="transcribiendo", radar_job_id="job-running"))
    radar = FakeRadarStatusClient(detail_by_job_id={"job-running": {"job_id": "job-running", "status": "running"}})
    enqueue_calls: list[str] = []

    synced = TranscriptSyncWorker(store=store, radar=radar, enqueue_due=lambda: enqueue_calls.append("enqueue_due")).sync_once()

    assert synced == []
    assert enqueue_calls == []


def test_transcript_sync_worker_immediate_enqueue_preserves_active_serial_guard(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="failed", channel_id=channel.id, title="Ecuador", lifecycle="enqueued", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="failed", target_country="ecuador", status="transcribiendo", radar_job_id="job-failed"))
    store.upsert_video(VideoRecord(video_id="still-running", channel_id=channel.id, title="Uruguay", lifecycle="enqueued", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="still-running", target_country="uruguay", status="transcribiendo", radar_job_id="job-running"))
    store.upsert_video(
        VideoRecord(video_id="ready-next", channel_id=channel.id, title="México", url="https://youtu.be/ready-next", lifecycle="enqueue_pending", matched=True)
    )
    store.upsert_target_match(store.make_target_match(video_id="ready-next", target_country="mexico", status="aprobado"))
    sync_radar = FakeRadarStatusClient(
        detail_by_job_id={
            "job-failed": {"job_id": "job-failed", "status": "failed"},
            "job-running": {"job_id": "job-running", "status": "running"},
        }
    )
    enqueue_radar = FakeRadarSubmitter()
    enqueue_worker = EnqueueWorker(store=store, radar=enqueue_radar, now=lambda: "2026-05-20T10:00:00Z")

    synced = TranscriptSyncWorker(store=store, radar=sync_radar, enqueue_due=enqueue_worker.enqueue_due).sync_once()

    assert synced == ["failed"]
    assert enqueue_radar.calls == []
    assert store.list_target_matches(video_id="ready-next")[0].status == "aprobado"


def test_transcript_sync_worker_fans_out_important_summary_from_enqueue_attempt_to_real_countries_only(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports",
            source_url=None,
            youtube_channel_id="UCImportant",
            important=True,
            priority_tier="importantes",
        )
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-fanout",
            channel_id=channel.id,
            title="Important summary fanout",
            lifecycle="enqueued",
            matched=True,
            classification_status="important_channel",
        )
    )
    store.record_enqueue_attempt(video_id="important-fanout", status="enqueued", radar_job_id="job-important")
    radar = FakeRadarStatusClient(
        detail_by_job_id={"job-important": {"job_id": "job-important", "status": "succeeded"}},
        summary_by_job_id={
            "job-important": {
                "items": [
                    {"country": "argentina", "label": "Argentina", "count": 2},
                    {"country": "mexico", "label": "México", "count": 1},
                    {"country": "uruguay", "label": "Uruguay", "count": 0},
                    {"country": "IMPORTANTES", "label": "Important", "count": 5},
                ]
            }
        },
    )

    synced = TranscriptSyncWorker(store=store, radar=radar).sync_once()

    assert synced == ["important-fanout"]
    assert radar.calls == [("detail", "job-important"), ("summary", "job-important")]
    assert store.list_important_cards()[0]["mention_counts_json"] == '[{"label":"Argentina","count":2},{"label":"México","count":1}]'
    assert [(match.target_country, match.status, match.approval_source) for match in store.list_target_matches(video_id="important-fanout")] == [
        ("mexico", "transcrito", "transcript_summary"),
    ]
    assert all(match.target_country not in {"argentina", "important", "importantes"} for match in store.list_target_matches(video_id="important-fanout"))


def test_transcript_sync_worker_fans_out_important_summary_to_multiple_non_source_countries_with_audit(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="uruguay", label="Important UY", source_url=None, youtube_channel_id="UCUy", important_mode="full_channel")
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-multi-fanout",
            channel_id=channel.id,
            title="Important multi fanout",
            lifecycle="enqueued",
            matched=True,
            classification_status="important",
            classification_version="title-country-v1",
            important_mode="full_channel",
            queue_priority_tier="important",
            queue_priority_rank=0,
        )
    )
    store.record_enqueue_attempt(video_id="important-multi-fanout", status="enqueued", radar_job_id="job-important-multi")
    radar = FakeRadarStatusClient(
        detail_by_job_id={"job-important-multi": {"job_id": "job-important-multi", "status": "succeeded"}},
        summary_by_job_id={
            "job-important-multi": {
                "items": [
                    {"country": "colombia", "label": "Colombia", "count": 3},
                    {"country": "ecuador", "label": "Ecuador", "count": 2},
                    {"country": "uruguay", "label": "Uruguay", "count": 5},
                    {"country": "important", "label": "Important", "count": 9},
                ]
            }
        },
    )

    synced = TranscriptSyncWorker(store=store, radar=radar).sync_once()

    assert synced == ["important-multi-fanout"]
    assert [
        (match.target_country, match.status, match.approval_source, match.classification_version, match.queue_priority_tier)
        for match in store.list_target_matches(video_id="important-multi-fanout")
    ] == [
        ("ecuador", "transcrito", "transcript_summary", "title-country-v1", "ecuador:normal"),
        ("colombia", "transcrito", "transcript_summary", "title-country-v1", "colombia:normal"),
    ]


def test_transcript_sync_worker_marks_zero_mention_important_job_complete_without_country_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="argentina", label="NSports", source_url=None, youtube_channel_id="UCImportant", important=True)
    )
    store.upsert_video(
        VideoRecord(video_id="important-zero", channel_id=channel.id, lifecycle="enqueued", matched=True, classification_status="important_channel")
    )
    store.record_enqueue_attempt(video_id="important-zero", status="enqueued", radar_job_id="job-zero")
    radar = FakeRadarStatusClient(
        detail_by_job_id={"job-zero": {"job_id": "job-zero", "status": "succeeded"}},
        summary_by_job_id={"job-zero": {"items": [{"country": "uruguay", "label": "Uruguay", "count": 0}]}},
    )

    synced = TranscriptSyncWorker(store=store, radar=radar).sync_once()

    assert synced == ["important-zero"]
    assert store.list_target_matches(video_id="important-zero") == []
    assert store.list_important_cards()[0]["mention_counts_json"] == "[]"
    assert store.list_enqueue_attempts("important-zero")[-1].status == "transcrito"


def test_transcript_sync_worker_keeps_geo_blocked_important_visible_without_country_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="peru", label="Mr Peet", source_url=None, youtube_channel_id="UCMrPeet", important_mode="program_rules")
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-geo-blocked",
            channel_id=channel.id,
            title="Madrugol con Mr Peet",
            lifecycle="enqueued",
            matched=True,
            classification_status="important",
            important_mode="program_rules",
            queue_priority_tier="important",
            queue_priority_rank=0,
        )
    )
    store.record_enqueue_attempt(video_id="important-geo-blocked", status="enqueued", radar_job_id="job-geo")
    radar = FakeRadarStatusClient(
        detail_by_job_id={
            "job-geo": {
                "job_id": "job-geo",
                "status": "failed",
                "error": {"code": "yt_dlp_failed", "message": "not made this video available in your country"},
            }
        }
    )

    synced = TranscriptSyncWorker(store=store, radar=radar).sync_once()

    assert synced == ["important-geo-blocked"]
    assert store.list_target_matches(video_id="important-geo-blocked") == []
    assert store.list_enqueue_attempts("important-geo-blocked")[-1].status == "geo_blocked"
    assert [(card["video_id"], card["target_country"], card["status"], card["last_error"]) for card in store.list_important_cards()] == [
        ("important-geo-blocked", "important", "geo_blocked", "yt_dlp_geo_blocked")
    ]


def test_transcript_sync_worker_marks_all_target_matches_error_when_job_fails(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="failed", channel_id=channel.id, title="Ecuador y México", lifecycle="enqueued", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="failed", target_country="ecuador", status="transcribiendo", radar_job_id="job-failed"))
    store.upsert_target_match(store.make_target_match(video_id="failed", target_country="mexico", status="transcribiendo", radar_job_id="job-failed"))
    radar = FakeRadarStatusClient(
        detail_by_job_id={"job-failed": {"job_id": "job-failed", "status": "failed", "error": {"code": "transcription_failed"}}}
    )

    synced = TranscriptSyncWorker(store=store, radar=radar).sync_once()

    assert synced == ["failed"]
    assert radar.calls == [("detail", "job-failed")]
    assert [(match.target_country, match.status, match.last_error) for match in store.list_target_matches(video_id="failed")] == [
        ("ecuador", "error", "transcription_failed"),
        ("mexico", "error", "transcription_failed"),
    ]


def test_transcript_sync_worker_preserves_typed_radar_failures_for_operator_labels(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    cases = [
        ("live-1", "ecuador", "job-live", "yt_dlp_live_pending"),
        ("copy-1", "mexico", "job-copy", "yt_dlp_copyright_blocked"),
        ("generic-1", "argentina", "job-generic", "unknown_provider_error"),
    ]
    for video_id, country, job_id, _code in cases:
        store.upsert_video(VideoRecord(video_id=video_id, channel_id=channel.id, title=f"Failed {video_id}", lifecycle="enqueued", matched=True))
        store.upsert_target_match(store.make_target_match(video_id=video_id, target_country=country, status="transcribiendo", radar_job_id=job_id))
    radar = FakeRadarStatusClient(
        detail_by_job_id={
            "job-live": {"job_id": "job-live", "status": "failed", "error": {"code": "yt_dlp_live_pending", "message": "live not started"}},
            "job-copy": {"job_id": "job-copy", "status": "failed", "error": {"code": "yt_dlp_copyright_blocked", "message": "blocked on copyright grounds"}},
            "job-generic": {"job_id": "job-generic", "status": "failed", "error": {"code": "unknown_provider_error", "message": "provider trace"}},
        }
    )

    synced = TranscriptSyncWorker(store=store, radar=radar).sync_once()

    assert synced == ["live-1", "copy-1", "generic-1"]
    assert [(match.video_id, match.status, match.last_error) for match in store.list_target_matches()] == [
        ("live-1", "error", "yt_dlp_live_pending"),
        ("generic-1", "error", "unknown_provider_error"),
        ("copy-1", "error", "yt_dlp_copyright_blocked"),
    ]


def test_transcript_sync_worker_marks_geo_blocked_jobs_terminal_without_retry(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="blocked", channel_id=channel.id, title="Ecuador", lifecycle="enqueued", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="blocked", target_country="ecuador", status="transcribiendo", radar_job_id="job-blocked"))
    radar = FakeRadarStatusClient(
        detail_by_job_id={
            "job-blocked": {
                "job_id": "job-blocked",
                "status": "failed",
                "error": {"code": "yt_dlp_failed", "message": "The uploader has not made this video available in your country"},
            }
        }
    )

    synced = TranscriptSyncWorker(store=store, radar=radar).sync_once()

    assert synced == ["blocked"]
    matches = store.list_target_matches(video_id="blocked")
    assert [(match.target_country, match.status, match.last_error) for match in matches] == [
        ("ecuador", "geo_blocked", "yt_dlp_geo_blocked")
    ]
    assert store.list_transcribing_video_jobs() == []


def test_metadata_unavailable_keeps_visible_failure_state_without_enqueue(tmp_path):
    store, _channel = make_store(tmp_path)
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube({"missing": MetadataUnavailable("missing")}),
        matcher=TitleMatcher(TitleCatalog(countries={"fr": ["france"]}, players=[])),
    )

    result = worker.process_video_id("missing")

    assert result.lifecycle == "metadata_failed"
    assert result.match_reason == "metadata_unavailable"
    assert result.matched is False


def test_discovery_worker_records_boundary_metadata_failure_reason_without_local_fallback(tmp_path):
    store, _channel = make_store(tmp_path)
    boundary_error = BoundaryMetadataUnavailable(
        "boundary-video",
        code="boundary_unreachable",
        message="Boundary request failed",
        retryable=True,
    )
    worker = DiscoveryWorker(
        store=store,
        youtube=FakeYouTube({"boundary-video": boundary_error}),
        matcher=TitleMatcher(TitleCatalog(countries={"fr": ["france"]}, players=[])),
    )

    result = worker.process_video_id("boundary-video")

    assert worker.youtube.calls == ["boundary-video"]
    assert result.lifecycle == "metadata_failed"
    assert result.match_reason == "boundary_unreachable"
    assert result.matched is False


class FakeWebSub:
    def __init__(self, accepted_by_channel: dict[str, bool]):
        self.accepted_by_channel = accepted_by_channel
        self.calls: list[str] = []

    def renew(self, channel_id: str, *, lease_seconds: int = 864000) -> bool:
        self.calls.append(channel_id)
        return self.accepted_by_channel[channel_id]


def test_websub_renewal_worker_records_failed_subscription_without_callback_secret(tmp_path):
    store, channel = make_store(tmp_path)
    websub = FakeWebSub({"UCStable": False})
    worker = WebSubRenewalWorker(
        store=store,
        websub=websub,
        callback_url="https://callback.example/api/monitor/websub?secret=callback-secret",
        now=lambda: "2026-05-20T10:00:00Z",
    )

    results = worker.renew_all()

    assert websub.calls == ["UCStable"]
    assert results[0].status == "failed"
    assert results[0].last_error == "websub_renewal_rejected"
    preflight = store.subscription_preflight(now="2026-05-20T10:00:00Z")
    assert preflight["findings"] == [
        {
            "code": "subscription_failed",
            "channel_id": channel.id,
            "youtube_channel_id": "UCStable",
            "label": "L'Équipe",
            "last_error": "websub_renewal_rejected",
        }
    ]


def test_websub_renewal_worker_records_boundary_retryable_reason_without_local_fallback(tmp_path):
    class BoundaryFailingWebSub:
        def __init__(self):
            self.calls: list[str] = []

        def renew(self, channel_id: str, *, lease_seconds: int = 864000) -> bool:
            self.calls.append(channel_id)
            raise BoundaryRequestError(code="boundary_unreachable", message="Boundary unavailable", retryable=True)

    store, _channel = make_store(tmp_path)
    websub = BoundaryFailingWebSub()
    worker = WebSubRenewalWorker(
        store=store,
        websub=websub,
        callback_url="https://boundary.example.test/v1/websub/callback",
        now=lambda: "2026-05-20T10:00:00Z",
    )

    results = worker.renew_all()

    assert websub.calls == ["UCStable"]
    assert [(subscription.status, subscription.last_error) for subscription in results] == [("failed", "boundary_unreachable")]


class FakeSubtitleProvider:
    def __init__(self, segments_by_video_id):
        self.segments_by_video_id = segments_by_video_id
        self.calls: list[tuple[str, str | None, str]] = []

    def fetch(self, *, video_id: str, source_language: str | None, default_language: str):
        self.calls.append((video_id, source_language, default_language))
        value = self.segments_by_video_id[video_id]
        if isinstance(value, Exception):
            raise value
        return value


class FakeAiAnalyzer:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def analyze(self, video):
        self.calls.append(video)
        return self.result


class FailingAiAnalyzer:
    def __init__(self, error: Exception):
        self.error = error
        self.calls = []

    def analyze(self, video):
        self.calls.append(video)
        raise self.error


def test_ai_rescue_worker_is_gated_off_and_does_not_call_fakes(tmp_path):
    from app.ai_rescue import AiRescueAnalysisResult

    store, _channel = make_store(tmp_path)
    store.upsert_video(VideoRecord(video_id="trash", title="Solo Colombia", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="trash", source_country="colombia", reason="no_title_match")
    store.enqueue_ai_rescue_rejected_video(video_id="trash", now="2026-05-22T10:00:00Z")
    subtitles = FakeSubtitleProvider({"trash": [SubtitleSegment(0, 22000, "Buen fútbol", "es")]})
    analyzer = FakeAiAnalyzer(AiRescueAnalysisResult(candidates=[], rejections=[]))

    processed = AiRescueWorker(
        store=store,
        subtitles=subtitles,
        analyzer=analyzer,
        enabled=False,
        now=lambda: "2026-05-22T10:00:00Z",
    ).drain_due()

    assert processed == []
    assert subtitles.calls == []
    assert analyzer.calls == []
    assert store.list_ai_rescue_queue(limit=1)[0].status == "waiting"


def test_ai_rescue_worker_processes_one_due_item_and_stores_candidates_and_rejections(tmp_path):
    from app.ai_rescue import AiRescueAnalysisResult, AiRescueCandidate, AiRescueEvidence, AiRescueRejection

    store, _channel = make_store(tmp_path)
    for video_id in ["old", "new"]:
        store.upsert_video(VideoRecord(video_id=video_id, title=f"{video_id} local", lifecycle="ignored_seen"))
        store.upsert_rejected_video(video_id=video_id, source_country="colombia", reason="no_valid_target_match")
        store.enqueue_ai_rescue_rejected_video(video_id=video_id, now=f"2026-05-22T10:0{len(video_id)}:00Z")
    subtitles = FakeSubtitleProvider({"old": [SubtitleSegment(1000, 23000, "Ecuador played great football", "es")]})
    analyzer = FakeAiAnalyzer(
        AiRescueAnalysisResult(
            candidates=[
                AiRescueCandidate(
                    target_country="ecuador",
                    score=90,
                    summary_es="Elogio a Ecuador.",
                    angle_es="Rendimiento futbolístico.",
                    risk="low",
                    risks=["Sin riesgo"],
                    evidence=[AiRescueEvidence(1000, 23000, "Ecuador played", "Ecuador jugó", "Elogio futbolístico.")],
                )
            ],
            rejections=[AiRescueRejection(target_country="mexico", reason="weak-evidence", explanation_es="Mención débil")],
            raw_response_json='{"candidates":[]}',
        )
    )

    processed = AiRescueWorker(
        store=store,
        subtitles=subtitles,
        analyzer=analyzer,
        enabled=True,
        now=lambda: "2026-05-22T10:30:00Z",
    ).drain_due()

    assert processed == ["old"]
    assert subtitles.calls == [("old", "colombia", "en")]
    assert analyzer.calls[0].video_id == "old"
    assert analyzer.calls[0].source_language == "es"
    assert [(candidate.target_country, candidate.score) for candidate in store.list_ai_rescue_candidates()] == [("ecuador", 90)]
    assert [(item.video_id, item.status) for item in store.list_ai_rescue_queue(limit=10)] == [
        ("new", "waiting"),
        ("old", "candidate"),
    ]
    assert [(rejection.target_country, rejection.reason) for rejection in store.list_ai_rescue_rejections()] == [
        ("mexico", "weak-evidence")
    ]


def test_ai_rescue_worker_retries_missing_subtitles_without_blocking_other_due_work(tmp_path):
    from app.ai_rescue import AiRescueAnalysisResult

    store, _channel = make_store(tmp_path)
    for video_id in ["missing", "ready"]:
        store.upsert_video(VideoRecord(video_id=video_id, title=video_id, lifecycle="ignored_seen"))
        store.upsert_rejected_video(video_id=video_id, source_country="colombia", reason="no_title_match")
        store.enqueue_ai_rescue_rejected_video(video_id=video_id, now="2026-05-22T10:00:00Z")
    subtitles = FakeSubtitleProvider(
        {
            "missing": SubtitleUnavailable("missing", "colombia"),
            "ready": [SubtitleSegment(0, 22000, "Ecuador great football", "es")],
        }
    )
    analyzer = FakeAiAnalyzer(AiRescueAnalysisResult(candidates=[], rejections=[]))
    worker = AiRescueWorker(
        store=store,
        subtitles=subtitles,
        analyzer=analyzer,
        enabled=True,
        retry_attempts=3,
        retry_interval_seconds=7200,
        now=lambda: "2026-05-22T10:00:00Z",
    )

    first = worker.drain_due()
    second = worker.drain_due()

    queue = store.list_ai_rescue_queue(limit=10)
    assert first == ["missing"]
    assert second == ["ready"]
    assert [(item.video_id, item.status, item.attempt_count, item.next_attempt_at) for item in queue] == [
        ("missing", "retry", 1, "2026-05-22T12:00:00Z"),
        ("ready", "rejected", 0, None),
    ]


def test_ai_rescue_worker_marks_no_subtitles_after_final_retry(tmp_path):
    from app.ai_rescue import AiRescueAnalysisResult

    store, _channel = make_store(tmp_path)
    store.upsert_video(VideoRecord(video_id="missing", title="missing", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="missing", source_country="colombia", reason="no_title_match")
    item = store.enqueue_ai_rescue_rejected_video(video_id="missing", now="2026-05-22T10:00:00Z")
    store.schedule_ai_rescue_retry(item.id, now="2026-05-22T10:00:00Z", next_attempt_at="2026-05-22T12:00:00Z", last_error="no-subtitles")
    store.schedule_ai_rescue_retry(item.id, now="2026-05-22T12:00:00Z", next_attempt_at="2026-05-22T14:00:00Z", last_error="no-subtitles")

    unavailable = SubtitleUnavailable(
        "missing",
        "es",
        reason="transcripts_disabled",
        details={"provider": "youtube-transcript-api", "reason": "transcripts_disabled", "video_id": "missing", "language": "es"},
    )
    processed = AiRescueWorker(
        store=store,
        subtitles=FakeSubtitleProvider({"missing": unavailable}),
        analyzer=FakeAiAnalyzer(AiRescueAnalysisResult(candidates=[], rejections=[])),
        enabled=True,
        retry_attempts=3,
        retry_interval_seconds=7200,
        now=lambda: "2026-05-22T14:00:00Z",
    ).drain_due()

    queue_item = store.list_ai_rescue_queue(limit=1)[0]
    assert processed == ["missing"]
    assert (queue_item.status, queue_item.attempt_count, queue_item.last_error) == ("rejected", 3, "no-subtitles")
    rejections = store.list_ai_rescue_rejections()
    assert [(rejection.source, rejection.reason, rejection.video_id) for rejection in rejections] == [
        ("system", "no-subtitles", "missing")
    ]
    assert rejections[0].details_json == (
        '{"error":"Subtitles unavailable for video missing in es: transcripts_disabled",'
        '"subtitle_error":{"provider":"youtube-transcript-api","reason":"transcripts_disabled",'
        '"video_id":"missing","language":"es"}}'
    )


def test_ai_rescue_worker_retries_sanitized_opencode_failures_without_sticking_processing(tmp_path):
    store, _channel = make_store(tmp_path)
    store.upsert_video(VideoRecord(video_id="opencode-fail", title="Ecuador", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="opencode-fail", source_country="colombia", reason="no_title_match")
    store.enqueue_ai_rescue_rejected_video(video_id="opencode-fail", now="2026-05-22T10:00:00Z")

    processed = AiRescueWorker(
        store=store,
        subtitles=FakeSubtitleProvider({"opencode-fail": [SubtitleSegment(0, 22000, "Ecuador great", "es")]}),
        analyzer=FailingAiAnalyzer(OpenCodeGoError("OpenCode Go request failed with status 503 for Bearer secret")),
        enabled=True,
        retry_attempts=3,
        retry_interval_seconds=600,
        now=lambda: "2026-05-22T10:00:00Z",
    ).drain_due()

    queue_item = store.list_ai_rescue_queue(limit=1)[0]
    assert processed == ["opencode-fail"]
    assert (queue_item.status, queue_item.attempt_count, queue_item.next_attempt_at) == (
        "retry",
        1,
        "2026-05-22T10:10:00Z",
    )
    assert queue_item.last_error == "opencode_error"
    assert "secret" not in queue_item.last_error


def test_ai_rescue_worker_final_rejects_invalid_ai_json_after_bounded_retries(tmp_path):
    store, _channel = make_store(tmp_path)
    store.upsert_video(VideoRecord(video_id="invalid-json", title="Ecuador", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="invalid-json", source_country="colombia", reason="no_title_match")
    item = store.enqueue_ai_rescue_rejected_video(video_id="invalid-json", now="2026-05-22T10:00:00Z")
    store.schedule_ai_rescue_retry(item.id, now="2026-05-22T10:00:00Z", next_attempt_at="2026-05-22T10:10:00Z", last_error="analysis_error")

    processed = AiRescueWorker(
        store=store,
        subtitles=FakeSubtitleProvider({"invalid-json": [SubtitleSegment(0, 22000, "Ecuador great", "es")]}),
        analyzer=FailingAiAnalyzer(ValueError("invalid JSON: token api-key-123")),
        enabled=True,
        retry_attempts=2,
        retry_interval_seconds=600,
        now=lambda: "2026-05-22T10:10:00Z",
    ).drain_due()

    queue_item = store.list_ai_rescue_queue(limit=1)[0]
    rejections = store.list_ai_rescue_rejections()
    assert processed == ["invalid-json"]
    assert (queue_item.status, queue_item.attempt_count, queue_item.last_error) == ("rejected", 2, "analysis_error")
    assert [(rejection.source, rejection.reason, rejection.video_id) for rejection in rejections] == [
        ("system", "analysis_error", "invalid-json")
    ]
    assert rejections[0].details_json == '{"error":"analysis_error"}'


def test_ai_rescue_worker_retries_general_expected_failures_with_sanitized_code(tmp_path):
    store, _channel = make_store(tmp_path)
    store.upsert_video(VideoRecord(video_id="timeout", title="Ecuador", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="timeout", source_country="colombia", reason="no_title_match")
    store.enqueue_ai_rescue_rejected_video(video_id="timeout", now="2026-05-22T10:00:00Z")

    processed = AiRescueWorker(
        store=store,
        subtitles=FakeSubtitleProvider({"timeout": [SubtitleSegment(0, 22000, "Ecuador great", "es")]}),
        analyzer=FailingAiAnalyzer(TimeoutError("request timed out with secret-token")),
        enabled=True,
        retry_attempts=3,
        retry_interval_seconds=600,
        now=lambda: "2026-05-22T10:00:00Z",
    ).drain_due()

    queue_item = store.list_ai_rescue_queue(limit=1)[0]
    assert processed == ["timeout"]
    assert (queue_item.status, queue_item.attempt_count, queue_item.last_error) == ("retry", 1, "analysis_error")
    assert "secret-token" not in queue_item.last_error
