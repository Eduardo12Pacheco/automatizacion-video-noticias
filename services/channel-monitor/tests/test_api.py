from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.boundary_client import BoundaryRequestError, ChannelNetworkBoundaryClient
from app.main import create_app, _parse_mention_counts
from app.settings import Settings
from app.store import ChannelRecord, MonitorStore, TargetMatchRecord, VideoRecord
from app.youtube_client import ChannelMetadata


def test_live_endpoint_is_public_and_minimal(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=StartupFakeChannelResolver()))

    response = client.get("/api/monitor/live")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_monitor_cards_exposes_safe_channel_priority_rank(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="espana", label="Mundo Demo", source_url=None, youtube_channel_id="UCMundo", algorithm_priority_rank=11)
    )
    store.upsert_video(
        VideoRecord(
            video_id="priority-video",
            channel_id=channel.id,
            title="Aurenia analiza el partido",
            url="https://youtu.be/priority-video",
            published_at="2026-05-22T12:00:00Z",
            lifecycle="transcrito",
            matched=True,
        )
    )
    store.upsert_target_match(TargetMatchRecord(video_id="priority-video", target_country="aurenia", status="transcrito"))
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=StartupFakeChannelResolver()))

    response = client.get("/api/monitor/cards?target_country=aurenia", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    assert response.json()["items"][0]["channel_priority_rank"] == 11


def test_parse_mention_counts_ignores_malformed_counts():
    assert _parse_mention_counts('[{"label":"Bad","count":"oops"},{"label":"Good","count":"2"}]') == [
        {"label": "Good", "count": 2}
    ]


class FakeRuntimeCoordinator:
    def __init__(self):
        self.starts = 0
        self.stops = 0

    async def start(self):
        self.starts += 1

    async def stop(self):
        self.stops += 1

    def status(self):
        return {"status": "ready", "enabled": ["enqueue"], "running": ["enqueue"], "disabled": ["websub", "catchup"]}


class InspectingRuntimeCoordinator(FakeRuntimeCoordinator):
    def __init__(self, store: MonitorStore):
        super().__init__()
        self.store = store
        self.channels_at_start = []

    async def start(self):
        await super().start()
        self.channels_at_start = self.store.list_channels()


class StartupFakeChannelResolver:
    def __init__(self):
        self.calls: list[str] = []

    def resolve_channel(self, source: str) -> ChannelMetadata:
        self.calls.append(source)
        return ChannelMetadata(channel_id="UCFakeResolved", title="Resolved", uploads_playlist_id="UUFakeResolved")


class ExplodingChannelResolver:
    def resolve_channel(self, source: str) -> ChannelMetadata:
        raise AssertionError(f"preflight must not resolve channels: {source}")


def test_lifespan_starts_and_stops_injected_runtime_coordinator_once(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    runtime = FakeRuntimeCoordinator()

    with TestClient(
        create_app(
            settings=settings,
            store=store,
            runtime_coordinator=runtime,
            channel_resolver=StartupFakeChannelResolver(),
        )
    ) as client:
        response = client.get("/api/monitor/live")

    assert response.status_code == 200
    assert runtime.starts == 1
    assert runtime.stops == 1


def test_lifespan_syncs_configured_channels_before_runtime_start_with_injected_resolver(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: ar
    name: Valdoria
    channels:
      - url: https://www.youtube.com/@club/videos
        label: Club
        important: true
        important_mode: full_channel
        priority_tier: importantes
        algorithm_priority_rank: 3
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", channels_config_path=channels_path)
    store = MonitorStore(settings.db_path)
    store.migrate()
    runtime = InspectingRuntimeCoordinator(store)
    resolver = StartupFakeChannelResolver()

    with TestClient(create_app(settings=settings, store=store, runtime_coordinator=runtime, channel_resolver=resolver)):
        pass

    assert resolver.calls == ["https://www.youtube.com/@club/videos"]
    assert [(channel.youtube_channel_id, channel.important, channel.important_mode, channel.priority_tier, channel.algorithm_priority_rank) for channel in runtime.channels_at_start] == [
        ("UCFakeResolved", True, "full_channel", "importantes", 3)
    ]


def test_protected_mode_builders_use_boundary_clients_and_never_construct_local_youtube_providers(tmp_path, monkeypatch):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text("countries:\n  - code: aurenia\n    terms:\n      - Aurenia\nplayers: []\n", encoding="utf-8")
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=catalog_path,
        network_mode="protected",
        network_boundary_url="https://boundary.example.test",
        network_boundary_token="boundary-token",
        radar_url="http://transcript-service.test",
        radar_api_key="transcript-service-key",
        worker_websub_enabled=True,
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    def forbidden_local_provider(*args, **kwargs):
        raise AssertionError("local YouTube provider constructed in protected mode")

    monkeypatch.setattr(main_module, "RssChannelClient", forbidden_local_provider)
    monkeypatch.setattr(main_module, "WebSubClient", forbidden_local_provider)
    monkeypatch.setattr(main_module, "YouTubeTranscriptSubtitleProvider", forbidden_local_provider)
    monkeypatch.setattr(main_module, "YtDlpSubtitleProvider", forbidden_local_provider)

    resolver = main_module._build_channel_resolver(settings=settings)
    discovery = main_module._build_discovery_worker(settings=settings, store=store)
    catchup = main_module._build_catchup_worker(settings=settings, store=store, discovery_worker=discovery)
    websub = main_module._build_websub_worker(settings=settings, store=store)

    assert isinstance(resolver, ChannelNetworkBoundaryClient)
    assert isinstance(discovery.youtube, ChannelNetworkBoundaryClient)
    assert isinstance(catchup.youtube, ChannelNetworkBoundaryClient)
    assert isinstance(websub.websub, ChannelNetworkBoundaryClient)
    assert websub.callback_url == "https://boundary.example.test/v1/websub/callback"


def test_protected_discovery_builder_fails_closed_when_boundary_config_missing_with_local_api_key(tmp_path, monkeypatch):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text("countries:\n  - code: aurenia\n    terms:\n      - Aurenia\nplayers: []\n", encoding="utf-8")
    settings = Settings(
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=catalog_path,
        network_mode="protected",
        network_boundary_url="",
        network_boundary_token="",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    def forbidden_local_provider(*args, **kwargs):
        raise AssertionError("local YouTube provider constructed when boundary config is missing")

    monkeypatch.setattr(main_module, "RssChannelClient", forbidden_local_provider)

    try:
        main_module._build_discovery_worker(settings=settings, store=store)
    except BoundaryRequestError as exc:
        assert exc.code == "boundary_misconfigured"
    else:
        raise AssertionError("protected discovery builder must fail closed when boundary config is missing")


def test_protected_catchup_builder_fails_closed_when_boundary_config_missing_with_local_api_key(tmp_path, monkeypatch):
    settings = Settings(
        db_path=tmp_path / "monitor.sqlite3",
        network_mode="protected",
        network_boundary_url="",
        network_boundary_token="",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    def forbidden_local_provider(*args, **kwargs):
        raise AssertionError("local YouTube provider constructed when boundary config is missing")

    monkeypatch.setattr(main_module, "RssChannelClient", forbidden_local_provider)

    try:
        main_module._build_catchup_worker(settings=settings, store=store, discovery_worker=object())
    except BoundaryRequestError as exc:
        assert exc.code == "boundary_misconfigured"
    else:
        raise AssertionError("protected catchup builder must fail closed when boundary config is missing")



def test_local_dev_builders_keep_explicit_local_provider_path(tmp_path):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text("countries:\n  - code: aurenia\n    terms:\n      - Aurenia\nplayers: []\n", encoding="utf-8")
    settings = Settings(
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=catalog_path,
        network_mode="local_dev",
        callback_url="https://monitor.example.test/api/monitor/websub",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    resolver = main_module._build_channel_resolver(settings=settings)
    discovery = main_module._build_discovery_worker(settings=settings, store=store)
    websub = main_module._build_websub_worker(settings=settings, store=store)

    assert resolver.__class__.__name__ == "RssChannelClient"
    assert discovery.youtube.__class__.__name__ == "RssChannelClient"
    assert websub.websub.__class__.__name__ == "WebSubClient"


def test_health_requires_api_key_and_redacts_secrets(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@demo-sports-fr
        label: Demo Sports FR
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        channels_config_path=channels_path,
        radar_api_key="radar-secret",
        callback_secret="callback-secret",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=StartupFakeChannelResolver()))

    unauthorized = client.get("/api/monitor/health")
    authorized = client.get("/api/monitor/health", headers={"x-api-key": "monitor-secret"})

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    body = authorized.json()
    assert body["status"] in {"ok", "degraded"}
    assert body["checks"]["channels"]["status"] == "ready"
    assert "radar-secret" not in str(body)
    assert "youtube-secret" not in str(body)
    assert "callback-secret" not in str(body)


def test_health_reports_duplicate_channel_preflight_failure(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@demo-sports-fr
        label: Demo Sports FR
      - url: https://www.youtube.com/@demo-sports-fr
        label: Duplicate
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", channels_config_path=channels_path)
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/health", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["checks"]["channels"]["status"] == "failed"
    assert body["checks"]["channels"]["findings"][0]["code"] == "duplicate_channel_source"


def test_preflight_defers_channel_sync_without_calling_resolver(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@demo-sports-fr
        label: Demo Sports FR
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", channels_config_path=channels_path)
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=ExplodingChannelResolver()))

    response = client.get("/api/monitor/preflight", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    channels = response.json()["checks"]["channels"]
    assert channels["status"] == "ready"
    assert channels["configured_count"] == 1
    assert channels["stored_count"] == 0
    assert channels["sync"]["status"] == "deferred"
    assert channels["sync"]["code"] == "channel_sync_deferred"


def test_preflight_alias_is_authenticated_and_returns_same_check_shape(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@demo-sports-fr
        label: Demo Sports FR
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", channels_config_path=channels_path)
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.get("/api/monitor/preflight")
    authorized = client.get("/api/monitor/preflight", headers={"x-api-key": "monitor-secret"})

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    assert set(authorized.json()["checks"]) == {
        "sqlite",
        "channels",
        "radar",
        "channel_feed",
        "websub_callback",
        "websub_subscriptions",
        "catchup",
        "cleanup",
        "runtime",
        "classification",
    }
    assert "catchup" in authorized.json()["checks"]["runtime"]["enabled"]









def test_preflight_and_summary_include_classification_metadata_without_secrets(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        radar_api_key="radar-secret",
        classification_version="title-country-v1",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    store.create_classification_run(
        classification_version="title-country-v1",
        mode="apply",
        status="completed",
        candidate_count=0,
        parameters_json="{}",
    )
    client = TestClient(create_app(settings=settings, store=store))

    preflight = client.get("/api/monitor/preflight", headers={"x-api-key": "monitor-secret"})
    summary = client.get("/api/monitor/summary", headers={"x-api-key": "monitor-secret"})

    assert preflight.status_code == 200
    assert preflight.json()["checks"]["classification"] == {
        "status": "ready",
        "version": "title-country-v1",
        "latest_run_id": 1,
        "stale_count": 0,
    }
    assert summary.status_code == 200
    assert summary.json()["classification"] == {"version": "title-country-v1", "stale_count": 0}
    assert "radar-secret" not in preflight.text + summary.text


def test_runtime_preflight_includes_transcript_sync_loop_when_radar_is_configured(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        radar_url="http://radar.local",
        radar_api_key="radar-secret",
        worker_enqueue_enabled=False,
        worker_pending_live_enabled=False,
        worker_cleanup_enabled=False,
        worker_catchup_enabled=False,
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/preflight", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    assert "transcript_sync" in response.json()["checks"]["runtime"]["enabled"]


def test_preflight_reports_catchup_degraded_for_enabled_channel_missing_upload_playlist(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/preflight", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    catchup = response.json()["checks"]["catchup"]
    assert catchup["status"] == "degraded"
    assert catchup["findings"][0]["code"] == "catchup_upload_playlist_missing"


def test_preflight_reports_radar_and_cleanup_without_secret_values(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@demo-sports-fr
        label: Demo Sports FR
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        channels_config_path=channels_path,
        radar_url="http://127.0.0.1:8765",
        radar_api_key="radar-secret",
        callback_url="https://callback.example/api/monitor/websub",
        callback_secret="callback-secret",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    runtime = FakeRuntimeCoordinator()
    client = TestClient(create_app(settings=settings, store=store, runtime_coordinator=runtime))

    response = client.get("/api/monitor/preflight", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    body = response.json()
    assert body["checks"]["radar"]["status"] in {"ready", "degraded", "failed"}
    assert body["checks"]["radar"]["url_configured"] is True
    assert body["checks"]["radar"]["api_key_configured"] is True
    assert body["checks"]["runtime"] == runtime.status()
    assert body["checks"]["cleanup"]["status"] == "ready"
    assert "radar-secret" not in response.text
    assert "youtube-secret" not in response.text
    assert "callback-secret" not in response.text


def test_cleanup_dry_run_endpoint_reports_expired_detected_videos_without_mutation(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", cleanup_retention_hours=120)
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="expired-api",
            channel_id=channel.id,
            title="Expired",
            url="https://www.youtube.com/watch?v=expired-api",
            lifecycle="enqueued",
            detected_at="2026-05-21T09:00:00Z",
        )
    )
    store.upsert_target_match(TargetMatchRecord(video_id="expired-api", target_country="aurenia", status="transcribiendo", radar_job_id="job-api"))
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.get("/api/monitor/cleanup/dry-run")
    before_matches = store.list_target_matches(video_id="expired-api")
    response = client.get(
        "/api/monitor/cleanup/dry-run",
        headers={"x-api-key": "monitor-secret"},
        params={"now": "2026-05-26T10:00:00Z"},
    )
    after_matches = store.list_target_matches(video_id="expired-api")

    assert unauthorized.status_code == 401
    assert response.status_code == 200
    assert response.json()["summary"]["video_count"] == 1
    assert response.json()["items"][0]["video_id"] == "expired-api"
    assert response.json()["items"][0]["transcript_refs"]["radar_job_ids"] == ["job-api"]
    assert before_matches == after_matches


def test_preflight_reports_websub_subscription_findings_per_channel_without_secrets(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        callback_url="https://callback.example/api/monitor/websub?secret=callback-secret",
        callback_secret="callback-secret",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    healthy = store.upsert_channel(
        ChannelRecord(country="fr", label="Healthy", source_url=None, youtube_channel_id="UCHealthy")
    )
    expiring = store.upsert_channel(
        ChannelRecord(country="fr", label="Expiring", source_url=None, youtube_channel_id="UCExpiring")
    )
    failed = store.upsert_channel(
        ChannelRecord(country="fr", label="Failed", source_url=None, youtube_channel_id="UCFailed")
    )
    store.upsert_channel(ChannelRecord(country="fr", label="Missing", source_url=None, youtube_channel_id="UCMissing"))
    store.record_subscription(
        channel_id=healthy.id,
        callback_url=settings.callback_url,
        lease_seconds=864000,
        expires_at="2099-05-30T10:00:00Z",
        last_renewed_at="2026-05-20T10:00:00Z",
        status="ready",
    )
    store.record_subscription(
        channel_id=expiring.id,
        callback_url=settings.callback_url,
        lease_seconds=864000,
        expires_at="2026-05-20T12:00:00Z",
        last_renewed_at="2026-05-10T12:00:00Z",
        status="ready",
    )
    store.record_subscription(
        channel_id=failed.id,
        callback_url=settings.callback_url,
        lease_seconds=864000,
        expires_at="2099-05-30T10:00:00Z",
        last_renewed_at="2026-05-20T10:00:00Z",
        status="failed",
        last_error="hub_503",
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/preflight", headers={"x-api-key": "monitor-secret"})

    findings = response.json()["checks"]["websub_subscriptions"]["findings"]
    assert response.status_code == 200
    assert response.json()["checks"]["websub_subscriptions"]["status"] == "failed"
    assert [finding["code"] for finding in findings] == [
        "subscription_expiring",
        "subscription_failed",
        "subscription_missing",
    ]
    assert [finding["youtube_channel_id"] for finding in findings] == ["UCExpiring", "UCFailed", "UCMissing"]
    assert "callback-secret" not in response.text
    assert settings.callback_url not in response.text


def test_monitor_cards_endpoint_is_authenticated_read_only_and_redacts_secrets(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        radar_api_key="radar-secret",
        callback_secret="callback-secret",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="aurenia", label="El Canal", source_url=None, youtube_channel_id="UCEcuador")
    )
    store.upsert_video(
        VideoRecord(
            video_id="aurenia-video",
            channel_id=channel.id,
            title="Aurenia gana el partido",
            url="https://youtu.be/aurenia-video",
            published_at="2026-05-21T15:30:00Z",
            lifecycle="enqueue_pending",
            matched=True,
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="aurenia-video",
            target_country="aurenia",
            status="transcribiendo",
            radar_job_id="radar-job-ec",
        )
    )
    store.record_enqueue_attempt(video_id="aurenia-video", status="submitted", radar_job_id="radar-job-ec")
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.get("/api/monitor/cards")
    before_attempts = store.list_enqueue_attempts("aurenia-video")
    authorized = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"})
    after_attempts = store.list_enqueue_attempts("aurenia-video")

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    assert authorized.json() == {
        "status": "ok",
        "degraded": False,
        "items": [
            {
                "id": "aurenia-video:aurenia",
                "video_id": "aurenia-video",
                "title": "Aurenia gana el partido",
                "url": "https://youtu.be/aurenia-video",
                "target_country": "aurenia",
                "target_country_label": "Aurenia",
                "source_country": "aurenia",
                "source_country_label": "Aurenia",
                "channel_label": "El Canal",
                "published_at": "2026-05-21T15:30:00Z",
                "status": "transcribiendo",
                "approval_source": "title_classifier",
                "display_status": "TRANSCRIBIENDO",
                "radar_job_id": "radar-job-ec",
                "last_error": None,
                "mention_status": "pending_summary",
                "mention_counts": [],
                "classification_version": "title-country-v1",
            }
        ],
        "pagination": {"limit": 200, "offset": 0, "total": 1, "has_more": False},
    }
    assert before_attempts == after_attempts
    assert "radar-secret" not in authorized.text
    assert "youtube-secret" not in authorized.text
    assert "callback-secret" not in authorized.text


def test_monitor_cards_endpoint_returns_empty_and_degraded_metadata(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store, radar_client=None))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    assert response.json() == {
        "status": "degraded",
        "degraded": True,
        "degraded_reasons": ["radar_client_unavailable"],
        "items": [],
        "pagination": {"limit": 200, "offset": 0, "total": 0, "has_more": False},
    }


def test_radar_baseline_reset_endpoint_requires_auth_confirmation_and_backup(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", uploads_playlist_id="UUCaracol"))
    store.upsert_video(VideoRecord(video_id="legacy", channel_id=channel.id, title="Legacy", lifecycle="ignored_seen"))
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.post("/api/monitor/radar-baseline-reset", json={"mode": "dry-run"})
    dry_run = client.post("/api/monitor/radar-baseline-reset", headers={"x-api-key": "monitor-secret"}, json={"mode": "dry-run", "backup_path": str(tmp_path / "backup.bak"), "baseline_started_at": "2026-05-28T20:00:00Z"})
    missing_confirm = client.post("/api/monitor/radar-baseline-reset", headers={"x-api-key": "monitor-secret"}, json={"mode": "apply", "backup_path": str(tmp_path / "backup.bak")})

    assert unauthorized.status_code == 401
    assert dry_run.status_code == 200
    assert dry_run.json()["status"] == "dry-run"
    assert dry_run.json()["videos_planned"] == 1
    assert store.get_video("legacy") is not None
    assert missing_confirm.status_code == 400
    assert missing_confirm.json()["detail"]["code"] == "confirmation_required"


def test_radar_baseline_reset_apply_clears_state_and_preserves_channels(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", uploads_playlist_id="UUCaracol"))
    store.upsert_video(VideoRecord(video_id="legacy", channel_id=channel.id, title="Legacy", lifecycle="ignored_seen"))
    client = TestClient(create_app(settings=settings, store=store))

    response = client.post("/api/monitor/radar-baseline-reset", headers={"x-api-key": "monitor-secret"}, json={"mode": "apply", "confirm": "RESET_RADAR_BASELINE", "backup_path": str(tmp_path / "backup.bak"), "baseline_started_at": "2026-05-28T20:00:00Z"})

    assert response.status_code == 200
    assert response.json()["status"] == "applied"
    assert store.get_video("legacy") is None
    assert store.find_channel_by_youtube_id("UCCaracol").baseline_started_at == "2026-05-28T20:00:00Z"


def test_monitor_cards_endpoint_serializes_missing_radar_linkage_as_pending_mentions(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="valdoria", label="Demo TV", source_url=None, youtube_channel_id="UCDemo TV")
    )
    store.upsert_video(
        VideoRecord(
            video_id="valdoria-unlinked",
            channel_id=channel.id,
            title="Video pendiente de Radar",
            url="https://youtu.be/valdoria-unlinked",
            published_at="2026-05-21T17:00:00Z",
            lifecycle="discovered",
            matched=True,
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(video_id="valdoria-unlinked", target_country="valdoria", status="aprobado")
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    assert response.json()["items"] == [
        {
            "id": "valdoria-unlinked:valdoria",
            "video_id": "valdoria-unlinked",
            "title": "Video pendiente de Radar",
            "url": "https://youtu.be/valdoria-unlinked",
            "target_country": "valdoria",
            "target_country_label": "Valdoria",
            "source_country": "valdoria",
            "source_country_label": "Valdoria",
            "channel_label": "Demo TV",
            "published_at": "2026-05-21T17:00:00Z",
            "status": "aprobado",
            "approval_source": "title_classifier",
            "display_status": "APROBADO",
            "radar_job_id": None,
            "last_error": None,
            "mention_status": "pending_summary",
            "mention_counts": [],
            "classification_version": "title-country-v1",
        }
    ]


def test_monitor_cards_endpoint_displays_geo_blocked_target_status(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="blocked-video",
            channel_id=channel.id,
            title="Video bloqueado",
            url="https://youtu.be/blocked-video",
            published_at="2026-05-21T17:30:00Z",
            lifecycle="enqueued",
            matched=True,
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="blocked-video",
            target_country="aurenia",
            status="geo_blocked",
            radar_job_id="radar-blocked",
            last_error="yt_dlp_geo_blocked",
        )
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["status"] == "geo_blocked"
    assert item["display_status"] == "GEO-BLOQUEADO"
    assert item["last_error"] == "yt_dlp_geo_blocked"


def test_monitor_cards_endpoint_maps_known_failures_to_spanish_display_statuses(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    cases = [
        ("bot-video", "aurenia", "yt_dlp_bot_check", "BLOQUEO YOUTUBE"),
        ("live-video", "terramar", "yt_dlp_live_pending", "LIVE PENDIENTE"),
        ("copy-video", "valdoria", "yt_dlp_copyright_blocked", "COPYRIGHT"),
        ("timeout-video", "rivamar", "yt_dlp_timeout", "TIMEOUT"),
        ("private-video", "bosquemar", "yt_dlp_private_or_removed", "NO DISPONIBLE"),
        ("technical-video", "montelia", "ffmpeg_failed", "FALLO TÉCNICO"),
        ("unknown-video", "aurenia", "provider_new_failure", "ERROR"),
    ]
    for video_id, target_country, last_error, _label in cases:
        store.upsert_video(VideoRecord(video_id=video_id, channel_id=channel.id, title=video_id, lifecycle="enqueued", matched=True))
        store.upsert_target_match(
            TargetMatchRecord(video_id=video_id, target_country=target_country, status="error", radar_job_id=f"job-{video_id}", last_error=last_error)
        )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"limit": 20})

    assert response.status_code == 200
    by_video = {item["video_id"]: item for item in response.json()["items"]}
    for video_id, _target_country, last_error, label in cases:
        assert by_video[video_id]["last_error"] == last_error
        assert by_video[video_id]["failure_code"] == last_error
        assert by_video[video_id]["display_status"] == label


def test_monitor_cards_endpoint_filters_target_rows_and_exposes_canonical_counts(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="multi",
            channel_id=channel.id,
            title="Aurenia y Terramar",
            url="https://youtu.be/multi",
            published_at="2026-05-21T18:00:00Z",
            lifecycle="enqueued",
            matched=True,
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="multi",
            target_country="terramar",
            status="transcrito",
            radar_job_id="radar-1",
            mention_counts_json='[{"label":"Terramar","count":2},{"label":"Cero","count":0}]',
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="multi",
            target_country="aurenia",
            status="aprobado",
            radar_job_id="radar-1",
        )
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "terramar"})

    assert response.status_code == 200
    assert response.json()["items"] == [
        {
            "id": "multi:terramar",
            "video_id": "multi",
            "title": "Aurenia y Terramar",
            "url": "https://youtu.be/multi",
            "target_country": "terramar",
            "target_country_label": "Terramar",
            "source_country": "montelia",
            "source_country_label": "Montelia",
            "channel_label": "Caracol",
            "published_at": "2026-05-21T18:00:00Z",
            "status": "transcrito",
            "approval_source": "title_classifier",
            "display_status": "TRANSCRITO",
            "radar_job_id": "radar-1",
            "last_error": None,
            "mention_status": "ready",
            "mention_counts": [{"label": "Terramar", "count": 2}],
            "classification_version": "title-country-v1",
        }
    ]


def test_card_dismissal_endpoint_requires_auth_validates_payload_and_filters_cards_summary(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", important=True)
    )
    store.upsert_video(
        VideoRecord(
            video_id="multi-dismiss",
            channel_id=channel.id,
            title="Aurenia y Montelia",
            url="https://youtu.be/multi-dismiss",
            published_at="2026-05-21T18:00:00Z",
            lifecycle="enqueued",
            matched=True,
            classification_status="important_channel",
        )
    )
    store.upsert_target_match(TargetMatchRecord(video_id="multi-dismiss", target_country="aurenia", status="aprobado"))
    store.upsert_target_match(TargetMatchRecord(video_id="multi-dismiss", target_country="montelia", status="transcrito"))
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.post(
        "/api/monitor/card-dismissals",
        json={"surface": "monitor-card", "target_context": "aurenia", "video_id": "multi-dismiss"},
    )
    invalid = client.post(
        "/api/monitor/card-dismissals",
        headers={"x-api-key": "monitor-secret"},
        json={"surface": "monitor-card", "target_context": "aurenia"},
    )
    dismissed = client.post(
        "/api/monitor/card-dismissals",
        headers={"x-api-key": "monitor-secret"},
        json={
            "surface": "monitor-card",
            "target_context": "Aurenia",
            "video_id": "multi-dismiss",
            "reason": "operator-dismissed",
            "dismissed_by": "control-panel",
        },
    )
    aurenia = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "aurenia"})
    montelia = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "montelia"})
    important = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "important"})
    summary = client.get("/api/monitor/summary", headers={"x-api-key": "monitor-secret"})

    assert unauthorized.status_code == 401
    assert invalid.status_code == 400
    assert invalid.json()["detail"]["code"] == "missing_dismissal_subject"
    assert dismissed.status_code == 200
    assert dismissed.json() == {"status": "dismissed", "context_key": "monitor-card:aurenia:multi-dismiss"}
    assert aurenia.json()["items"] == []
    assert aurenia.json()["pagination"]["total"] == 0
    assert [item["video_id"] for item in montelia.json()["items"]] == ["multi-dismiss"]
    assert [item["video_id"] for item in important.json()["items"]] == ["multi-dismiss"]
    ecuador_counts = next(item for item in summary.json()["targets"] if item["country"] == "aurenia")
    colombia_counts = next(item for item in summary.json()["targets"] if item["country"] == "montelia")
    assert ecuador_counts["aprobado"] == 0
    assert colombia_counts["transcrito"] == 1


def test_monitor_cards_endpoint_marks_transcribed_zero_mentions_as_ready(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="zero-mentions",
            channel_id=channel.id,
            title="Terramar sin menciones finales",
            url="https://youtu.be/zero-mentions",
            published_at="2026-05-21T19:00:00Z",
            lifecycle="enqueued",
            matched=True,
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="zero-mentions",
            target_country="terramar",
            status="transcrito",
            radar_job_id="radar-zero",
            mention_counts_json="[]",
        )
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "terramar"})

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["status"] == "transcrito"
    assert item["mention_status"] == "ready"
    assert item["mention_counts"] == []


def test_monitor_cards_endpoint_returns_empty_for_unmatched_target_country_without_legacy_fallback(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(video_id="aurenia-target", channel_id=channel.id, title="Aurenia candidato", lifecycle="enqueued")
    )
    store.upsert_target_match(TargetMatchRecord(video_id="aurenia-target", target_country="aurenia", status="aprobado"))
    store.upsert_video(
        VideoRecord(
            video_id="legacy-only",
            channel_id=channel.id,
            title="Legacy Montelia card",
            lifecycle="enqueue_pending",
            matched=True,
        )
    )
    store.record_enqueue_attempt(video_id="legacy-only", status="submitted", radar_job_id="legacy-job")
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "terramar"})

    assert response.status_code == 200
    assert response.json()["items"] == []


def test_monitor_cards_endpoint_derives_important_view_from_channel_membership_without_target_rows(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    important_channel = store.upsert_channel(
        ChannelRecord(
            country="valdoria",
            label="Demo Sports",
            source_url=None,
            youtube_channel_id="UCImportant",
            important=True,
            priority_tier="importantes",
        )
    )
    normal_channel = store.upsert_channel(
        ChannelRecord(country="terramar", label="Normal", source_url=None, youtube_channel_id="UCNormal")
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-zero-api",
            channel_id=important_channel.id,
            title="Important without country mentions",
            url="https://youtu.be/important-zero-api",
            published_at="2026-05-27T12:00:00Z",
            lifecycle="enqueued",
            matched=True,
            classification_status="important_channel",
        )
    )
    store.record_enqueue_attempt(video_id="important-zero-api", status="transcrito", radar_job_id="job-important-zero")
    store.upsert_video(
        VideoRecord(video_id="normal-api", channel_id=normal_channel.id, title="Normal", lifecycle="enqueued", matched=True)
    )
    store.upsert_target_match(TargetMatchRecord(video_id="normal-api", target_country="terramar", status="transcrito"))
    client = TestClient(create_app(settings=settings, store=store))

    important = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "important"})
    terramar = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "terramar"})

    assert important.status_code == 200
    assert important.json()["items"] == [
        {
            "id": "important-zero-api:important",
            "video_id": "important-zero-api",
            "title": "Important without country mentions",
            "url": "https://youtu.be/important-zero-api",
            "target_country": "important",
            "target_country_label": "IMPORTANTES",
            "source_country": "valdoria",
            "source_country_label": "Valdoria",
            "channel_label": "Demo Sports",
            "published_at": "2026-05-27T12:00:00Z",
            "status": "transcrito",
            "approval_source": "important_channel",
            "display_status": "TRANSCRITO",
            "radar_job_id": "job-important-zero",
            "last_error": None,
            "mention_status": "ready",
            "mention_counts": [],
            "classification_version": "title-country-v1",
            "important": True,
            "important_reason": "important_channel",
            "important_rule": None,
        }
    ]
    assert [item["video_id"] for item in terramar.json()["items"]] == ["normal-api"]
    assert store.list_target_matches(video_id="important-zero-api") == []


def test_monitor_cards_endpoint_adds_important_audit_fields_without_removing_legacy_fields(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="terramar",
            label="Deportes Terramar",
            source_url=None,
            youtube_channel_id="UCDemo SportsMX",
            important_mode="program_rules",
        )
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-program-api",
            channel_id=channel.id,
            title="Fútbol Demo EN VIVO",
            url="https://youtu.be/important-program-api",
            published_at="2026-05-27T13:00:00Z",
            lifecycle="enqueued",
            matched=True,
            classification_status="important",
            classification_reason="important_program_match",
            classification_version="important-v2",
            important_mode="program_rules",
            important_rule_json='{"op":"contains","value":"FUTBOL DEMO","normalized_value":"FUTBOL DEMO"}',
            queue_priority_tier="important",
            queue_priority_rank=0,
        )
    )
    store.record_enqueue_attempt(video_id="important-program-api", status="submitted", radar_job_id="job-important-program")
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "important"})

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert {
        "id",
        "video_id",
        "title",
        "url",
        "target_country",
        "target_country_label",
        "source_country",
        "source_country_label",
        "channel_label",
        "published_at",
        "status",
        "approval_source",
        "display_status",
        "radar_job_id",
        "last_error",
        "mention_status",
        "mention_counts",
        "classification_version",
    }.issubset(item)
    assert item["important"] is True
    assert item["important_reason"] == "important_program_match"
    assert item["important_rule"] == {"op": "contains", "value": "FUTBOL DEMO", "normalized_value": "FUTBOL DEMO"}
    assert item["source_country"] == "terramar"
    assert item["source_country_label"] == "Terramar"
    assert item["target_country"] == "important"
    assert item["target_country_label"] == "IMPORTANTES"
    assert item["status"] == "submitted"
    assert item["classification_version"] == "important-v2"


def test_monitor_cards_endpoint_keeps_geo_blocked_important_visible_without_country_target_row(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="rivamar",
            label="Fútbol Demo",
            source_url=None,
            youtube_channel_id="UCFutbolLibre",
            important_mode="full_channel",
        )
    )
    store.upsert_video(
        VideoRecord(
            video_id="geo-important-api",
            channel_id=channel.id,
            title="IMPORTANT geo blocked",
            url="https://youtu.be/geo-important-api",
            published_at="2026-05-27T14:00:00Z",
            lifecycle="geo_blocked",
            matched=True,
            classification_status="important_channel",
            classification_reason="important_full_channel",
            classification_version="important-v2",
            important_mode="full_channel",
            important_rule_json='{"type":"important_full_channel","label":"Fútbol Demo"}',
            queue_priority_tier="important",
            queue_priority_rank=0,
        )
    )
    store.record_enqueue_attempt(
        video_id="geo-important-api",
        status="geo_blocked",
        radar_job_id="job-geo-important",
        last_error="yt_dlp_geo_blocked",
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "important"})

    assert response.status_code == 200
    assert response.json()["items"][0]["video_id"] == "geo-important-api"
    assert response.json()["items"][0]["important"] is True
    assert response.json()["items"][0]["display_status"] == "GEO-BLOQUEADO"
    assert response.json()["items"][0]["important_reason"] == "important_full_channel"
    assert response.json()["items"][0]["important_rule"] == {"type": "important_full_channel", "label": "Fútbol Demo"}
    assert store.list_target_matches(video_id="geo-important-api") == []


def test_monitor_cards_endpoint_excludes_expired_important_videos_by_detected_at(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="valdoria", label="Demo Sports", source_url=None, youtube_channel_id="UCImportant", important=True)
    )
    store.upsert_video(
        VideoRecord(
            video_id="expired-important",
            channel_id=channel.id,
            title="Expired important",
            detected_at="2020-01-01T00:00:00Z",
            lifecycle="enqueued",
            matched=True,
            classification_status="important_channel",
        )
    )
    store.record_enqueue_attempt(video_id="expired-important", status="transcrito", radar_job_id="job-expired")
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "important"})

    assert response.status_code == 200
    assert response.json()["items"] == []


def test_monitor_cards_endpoint_excludes_basura_only_rejected_videos(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(video_id="basura-only", channel_id=channel.id, title="Solo Montelia", lifecycle="ignored_seen")
    )
    store.upsert_rejected_video(
        video_id="basura-only",
        source_country="montelia",
        reason="no_valid_target_match",
        match_reason_json='[{"country":"montelia"}]',
    )
    client = TestClient(create_app(settings=settings, store=store))

    cards = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"})
    basura = client.get("/api/monitor/basura", headers={"x-api-key": "monitor-secret"})

    assert cards.status_code == 200
    assert cards.json()["items"] == []
    assert basura.status_code == 200
    assert basura.json()["items"][0]["video_id"] == "basura-only"


def test_monitor_summary_and_basura_endpoints_are_authenticated_read_only(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="montelia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="approved", channel_id=channel.id, title="Aurenia", lifecycle="enqueue_pending"))
    store.upsert_target_match(TargetMatchRecord(video_id="approved", target_country="aurenia", status="aprobado"))
    store.upsert_video(VideoRecord(video_id="trash", channel_id=channel.id, title="Solo Montelia", lifecycle="ignored_seen"))
    store.upsert_rejected_video(
        video_id="trash",
        source_country="montelia",
        reason="no_valid_target_match",
        match_reason_json='[{"country":"montelia"}]',
    )
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.get("/api/monitor/basura")
    summary = client.get("/api/monitor/summary", headers={"x-api-key": "monitor-secret"})
    basura = client.get("/api/monitor/basura", headers={"x-api-key": "monitor-secret"})

    assert unauthorized.status_code == 401
    assert summary.status_code == 200
    assert summary.json()["basura_count"] == 1
    assert [(item["country"], item["aprobado"]) for item in summary.json()["targets"]][:2] == [
        ("aurenia", 1),
        ("montelia", 0),
    ]
    assert basura.status_code == 200
    assert basura.json()["total"] == 1
    assert basura.json()["items"] == [
        {
            "video_id": "trash",
            "title": "Solo Montelia",
            "url": None,
            "source_country": "montelia",
            "source_country_label": "Montelia",
            "channel_label": "Caracol",
            "published_at": None,
            "reason": "no_valid_target_match",
            "match_reasons": [{"country": "montelia"}],
            "classification_version": "title-country-v1",
        }
    ]


class FakeDiscoveryWorker:
    def __init__(self):
        self.video_ids: list[str] = []

    def process_video_id(self, video_id: str):
        self.video_ids.append(video_id)
        return None


class FakeChannelResolver:
    def __init__(self):
        self.calls: list[str] = []

    def resolve_channel(self, source: str) -> ChannelMetadata:
        self.calls.append(source)
        return ChannelMetadata(
            channel_id="UCDemoFrStable",
            title="Demo Sports FR",
            uploads_playlist_id="UUDemoFrStable",
        )


def test_channel_management_contract_lists_adds_and_updates_channels_with_auth(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    resolver = FakeChannelResolver()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=resolver))

    unauthorized = client.get("/api/monitor/channels")
    add_response = client.post(
        "/api/monitor/channels",
        headers={"x-api-key": "monitor-secret"},
        json={"country": "fr", "label": "Demo Sports FR API", "url": "https://www.youtube.com/@demo-sports-fr"},
    )
    list_response = client.get("/api/monitor/channels", headers={"x-api-key": "monitor-secret"})
    channel_id = add_response.json()["id"]
    update_response = client.patch(
        f"/api/monitor/channels/{channel_id}",
        headers={"x-api-key": "monitor-secret"},
        json={"label": "Demo Sports FR disabled", "enabled": False},
    )

    assert unauthorized.status_code == 401
    assert add_response.status_code == 201
    assert resolver.calls == ["https://www.youtube.com/@demo-sports-fr"]
    assert add_response.json() == {
        "id": channel_id,
        "country": "fr",
        "label": "Demo Sports FR API",
        "source_url": "https://www.youtube.com/@demo-sports-fr",
        "youtube_channel_id": "UCDemoFrStable",
        "uploads_playlist_id": "UUDemoFrStable",
        "enabled": True,
    }
    assert list_response.status_code == 200
    assert list_response.json()["channels"][0]["youtube_channel_id"] == "UCDemoFrStable"
    assert update_response.status_code == 200
    assert update_response.json()["label"] == "Demo Sports FR disabled"
    assert update_response.json()["enabled"] is False


def test_channel_management_contract_rejects_add_without_channel_source(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=FakeChannelResolver()))

    response = client.post(
        "/api/monitor/channels",
        headers={"x-api-key": "monitor-secret"},
        json={"country": "fr", "label": "Missing source"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "missing_channel_source"


# ---------------------------------------------------------------------------
# Regression tests for the POST/PATCH channel-management API fix.
#
# The `channel_id` (resolver-bypass) path used to create channels with
# uploads_playlist_id=NULL and baseline_started_at=NULL, making them
# invisible to the catchup worker. The PATCH endpoint also did not accept
# `uploads_playlist_id`, so an operator could not repair a broken channel
# without touching the DB. These tests pin the API contract in place.
# ---------------------------------------------------------------------------


def test_post_channels_with_channel_id_derives_uploads_playlist_id(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=ExplodingChannelResolver()))

    response = client.post(
        "/api/monitor/channels",
        headers={"x-api-key": "monitor-secret"},
        json={"country": "us", "label": "Soccer on Demo TV", "channel_id": "UC4Ck2X1L_hhoeK1tojW8PXA"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["youtube_channel_id"] == "UC4Ck2X1L_hhoeK1tojW8PXA"
    # YouTube convention: uploads playlist id is "UU" + channel_id[2:].
    assert body["uploads_playlist_id"] == "UU4Ck2X1L_hhoeK1tojW8PXA"
    # Brand-new channel must have a fresh baseline so the catchup worker
    # only ingests content published from this moment forward.
    stored = store.find_channel_by_youtube_id("UC4Ck2X1L_hhoeK1tojW8PXA")
    assert stored is not None
    assert stored.baseline_started_at is not None
    assert stored.baseline_started_at.endswith("Z")


def test_post_channels_with_channel_id_preserves_existing_uploads_playlist_id(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    # Seed an existing channel with a custom uploads_playlist_id and a
    # pre-existing baseline (e.g. set by a prior radar reset).
    store.upsert_channel(
        ChannelRecord(
            country="gb",
            label="The Overlap",
            source_url=None,
            youtube_channel_id="UCjXIw1GlwaY1IzpW_jN9iCQ",
            uploads_playlist_id="UUcustom-override",
            baseline_started_at="2025-01-01T00:00:00Z",
        )
    )
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=ExplodingChannelResolver()))

    response = client.post(
        "/api/monitor/channels",
        headers={"x-api-key": "monitor-secret"},
        json={"country": "gb", "label": "The Overlap renamed", "channel_id": "UCjXIw1GlwaY1IzpW_jN9iCQ"},
    )

    assert response.status_code == 201
    body = response.json()
    # The pre-existing custom playlist id must NOT be clobbered by the
    # derived "UU" + channel_id[2:] value.
    assert body["uploads_playlist_id"] == "UUcustom-override"
    # The pre-existing baseline must be preserved (no fresh stamp on
    # existing channels).
    stored = store.find_channel_by_youtube_id("UCjXIw1GlwaY1IzpW_jN9iCQ")
    assert stored is not None
    assert stored.baseline_started_at == "2025-01-01T00:00:00Z"


def test_post_channels_with_explicit_uploads_playlist_id_uses_payload_value(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=ExplodingChannelResolver()))

    response = client.post(
        "/api/monitor/channels",
        headers={"x-api-key": "monitor-secret"},
        json={
            "country": "br",
            "label": "Custom playlist channel",
            "channel_id": "UCcustom-1234",
            "uploads_playlist_id": "UUcustom-override-explicit",
        },
    )

    assert response.status_code == 201
    # The explicit payload value wins over the derived "UU" + channel_id[2:].
    assert response.json()["uploads_playlist_id"] == "UUcustom-override-explicit"


def test_post_channels_with_url_still_calls_resolver(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    resolver = FakeChannelResolver()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=resolver))

    response = client.post(
        "/api/monitor/channels",
        headers={"x-api-key": "monitor-secret"},
        json={"country": "fr", "label": "Demo Sports FR", "url": "https://www.youtube.com/@demo-sports-fr"},
    )

    assert response.status_code == 201
    assert resolver.calls == ["https://www.youtube.com/@demo-sports-fr"]
    # The resolver-derived playlist id (not the "UU" fallback) is used.
    assert response.json()["uploads_playlist_id"] == "UUDemoFrStable"
    # The url path leaves baseline_started_at untouched (the sync path
    # handles baseline stamping for resolver-created channels).
    stored = store.find_channel_by_youtube_id("UCDemoFrStable")
    assert stored is not None
    assert stored.baseline_started_at is None


def test_patch_channels_accepts_uploads_playlist_id(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    # Seed a channel with uploads_playlist_id=NULL (the broken state the
    # operator would want to repair via the API).
    channel = store.upsert_channel(
        ChannelRecord(
            country="ar",
            label="Broken channel",
            source_url=None,
            youtube_channel_id="UCbroken",
            uploads_playlist_id=None,
        )
    )
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=ExplodingChannelResolver()))

    response = client.patch(
        f"/api/monitor/channels/{channel.id}",
        headers={"x-api-key": "monitor-secret"},
        json={"uploads_playlist_id": "UUbroken-fixed"},
    )

    assert response.status_code == 200
    assert response.json()["uploads_playlist_id"] == "UUbroken-fixed"
    # Confirm the change landed in the store.
    stored = store.find_channel_by_id(channel.id)
    assert stored is not None
    assert stored.uploads_playlist_id == "UUbroken-fixed"


def test_patch_channels_preserves_existing_uploads_playlist_id_when_not_provided(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="ar",
            label="Healthy channel",
            source_url=None,
            youtube_channel_id="UChealthy",
            uploads_playlist_id="UUhealthy-existing",
        )
    )
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=ExplodingChannelResolver()))

    response = client.patch(
        f"/api/monitor/channels/{channel.id}",
        headers={"x-api-key": "monitor-secret"},
        json={"label": "Renamed healthy channel"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["label"] == "Renamed healthy channel"
    # The pre-existing playlist id is preserved when the field is not in
    # the PATCH payload.
    assert body["uploads_playlist_id"] == "UUhealthy-existing"


def test_preflight_reports_configured_channels_without_syncing_handle_urls(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@demo-sports-fr
        label: Demo Sports FR configured
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        channels_config_path=channels_path,
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    resolver = FakeChannelResolver()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=resolver))

    response = client.get("/api/monitor/preflight", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    channels = response.json()["checks"]["channels"]
    assert channels["status"] == "ready"
    assert channels["configured_count"] == 1
    assert channels["stored_count"] == 0
    assert channels["sync"]["status"] == "deferred"
    assert resolver.calls == []
    assert store.list_channels() == []


def test_websub_get_challenge_is_public_and_requires_verify_token(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        callback_secret="callback-secret",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store))

    accepted = client.get(
        "/api/monitor/websub",
        params={"hub.mode": "subscribe", "hub.challenge": "challenge-value", "hub.verify_token": "callback-secret"},
    )
    rejected = client.get(
        "/api/monitor/websub",
        params={"hub.mode": "subscribe", "hub.challenge": "challenge-value", "hub.verify_token": "wrong"},
    )

    assert accepted.status_code == 200
    assert accepted.text == "challenge-value"
    assert rejected.status_code == 403


def test_websub_post_validates_callback_and_processes_video_ids(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        callback_secret="callback-secret",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    worker = FakeDiscoveryWorker()
    client = TestClient(create_app(settings=settings, store=store, discovery_worker=worker))
    body = b"""<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>abc123</yt:videoId></entry></feed>"""

    response = client.post("/api/monitor/websub?secret=callback-secret", content=body)

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "video_ids": ["abc123"]}
    assert worker.video_ids == ["abc123"]


def test_boundary_websub_events_route_rejects_missing_or_wrong_event_api_key(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        boundary_event_api_key="boundary-event-secret",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store, discovery_worker=FakeDiscoveryWorker()))
    payload = {
        "event_id": "websub:UCBoundary:vid-1",
        "channel_id": "UCBoundary",
        "video_ids": ["vid-1"],
        "received_at": "2026-06-05T12:00:00Z",
    }

    missing = client.post("/api/monitor/boundary/websub-events", json=payload)
    wrong = client.post("/api/monitor/boundary/websub-events", headers={"x-boundary-event-api-key": "wrong"}, json=payload)

    assert missing.status_code == 401
    assert missing.json()["detail"]["code"] == "unauthorized"
    assert wrong.status_code == 401
    assert wrong.json()["detail"]["code"] == "unauthorized"


def test_boundary_websub_events_route_accepts_normalized_event_and_is_idempotent(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        boundary_event_api_key="boundary-event-secret",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    worker = FakeDiscoveryWorker()
    client = TestClient(create_app(settings=settings, store=store, discovery_worker=worker))
    payload = {
        "event_id": "websub:UCBoundary:vid-1,vid-2",
        "channel_id": "UCBoundary",
        "video_ids": ["vid-1", "vid-2", "vid-1"],
        "received_at": "2026-06-05T12:00:00Z",
    }
    headers = {"x-boundary-event-api-key": "boundary-event-secret"}

    first = client.post("/api/monitor/boundary/websub-events", headers=headers, json=payload)
    second = client.post("/api/monitor/boundary/websub-events", headers=headers, json=payload)

    assert first.status_code == 202
    assert first.json() == {
        "status": "accepted",
        "event_id": "websub:UCBoundary:vid-1,vid-2",
        "channel_id": "UCBoundary",
        "video_ids": ["vid-1", "vid-2"],
        "received_at": "2026-06-05T12:00:00Z",
        "duplicate": False,
    }
    assert second.status_code == 202
    assert second.json()["duplicate"] is True
    assert worker.video_ids == ["vid-1", "vid-2"]
    stored = store.get_boundary_websub_event("websub:UCBoundary:vid-1,vid-2")
    assert stored == {
        "event_id": "websub:UCBoundary:vid-1,vid-2",
        "channel_id": "UCBoundary",
        "video_ids": ["vid-1", "vid-2"],
        "received_at": "2026-06-05T12:00:00Z",
    }



def test_websub_challenge_and_callback_fail_closed_without_a_callback_secret(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    worker = FakeDiscoveryWorker()
    client = TestClient(create_app(settings=settings, store=store, discovery_worker=worker))
    body = b"""<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>abc123</yt:videoId></entry></feed>"""

    challenge = client.get(
        "/api/monitor/websub",
        params={"hub.mode": "subscribe", "hub.challenge": "challenge-value", "hub.verify_token": ""},
    )
    callback = client.post("/api/monitor/websub", content=body)

    assert challenge.status_code == 503
    assert callback.status_code == 403
    assert worker.video_ids == []
