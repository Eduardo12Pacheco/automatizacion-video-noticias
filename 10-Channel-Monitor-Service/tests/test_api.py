from __future__ import annotations

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

    with TestClient(create_app(settings=settings, store=store, runtime_coordinator=runtime)) as client:
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
    name: Argentina
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
    catalog_path.write_text("countries:\n  - code: ecuador\n    terms:\n      - Ecuador\nplayers: []\n", encoding="utf-8")
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=catalog_path,
        network_mode="protected",
        network_boundary_url="https://boundary.example.test",
        network_boundary_token="boundary-token",
        radar_url="http://transcript-service.test",
        radar_api_key="transcript-service-key",
        ai_rescue_enabled=True,
        ai_rescue_worker_enabled=True,
        ai_rescue_opencode_model="gpt-test",
        ai_rescue_opencode_api_key="opencode-token",
        worker_websub_enabled=True,
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    def forbidden_local_provider(*args, **kwargs):
        raise AssertionError("local YouTube provider constructed in protected mode")

    monkeypatch.setattr(main_module, "YouTubeDataClient", forbidden_local_provider)
    monkeypatch.setattr(main_module, "WebSubClient", forbidden_local_provider)
    monkeypatch.setattr(main_module, "YouTubeTranscriptSubtitleProvider", forbidden_local_provider)
    monkeypatch.setattr(main_module, "YtDlpSubtitleProvider", forbidden_local_provider)

    resolver = main_module._build_channel_resolver(settings=settings)
    discovery = main_module._build_discovery_worker(settings=settings, store=store)
    catchup = main_module._build_catchup_worker(settings=settings, store=store, discovery_worker=discovery)
    websub = main_module._build_websub_worker(settings=settings, store=store)
    ai_rescue = main_module._build_ai_rescue_worker(settings=settings, store=store)

    assert isinstance(resolver, ChannelNetworkBoundaryClient)
    assert isinstance(discovery.youtube, ChannelNetworkBoundaryClient)
    assert isinstance(catchup.youtube, ChannelNetworkBoundaryClient)
    assert isinstance(websub.websub, ChannelNetworkBoundaryClient)
    assert websub.callback_url == "https://boundary.example.test/v1/websub/callback"
    assert ai_rescue.subtitles.__class__.__name__ == "CompositeSubtitleProvider"
    assert isinstance(ai_rescue.subtitles.primary, ChannelNetworkBoundaryClient)
    assert ai_rescue.subtitles.fallback.__class__.__name__ == "TranscriptServiceSubtitleProvider"


def test_protected_discovery_builder_fails_closed_when_boundary_config_missing_with_local_api_key(tmp_path, monkeypatch):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text("countries:\n  - code: ecuador\n    terms:\n      - Ecuador\nplayers: []\n", encoding="utf-8")
    settings = Settings(
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=catalog_path,
        network_mode="protected",
        network_boundary_url="",
        network_boundary_token="",
        youtube_api_key="local-youtube-key-that-must-not-be-used",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    def forbidden_local_provider(*args, **kwargs):
        raise AssertionError("local YouTube provider constructed when boundary config is missing")

    monkeypatch.setattr(main_module, "YouTubeDataClient", forbidden_local_provider)

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
        youtube_api_key="local-youtube-key-that-must-not-be-used",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    def forbidden_local_provider(*args, **kwargs):
        raise AssertionError("local YouTube provider constructed when boundary config is missing")

    monkeypatch.setattr(main_module, "YouTubeDataClient", forbidden_local_provider)

    try:
        main_module._build_catchup_worker(settings=settings, store=store, discovery_worker=object())
    except BoundaryRequestError as exc:
        assert exc.code == "boundary_misconfigured"
    else:
        raise AssertionError("protected catchup builder must fail closed when boundary config is missing")


def test_protected_ai_rescue_builder_fails_closed_when_boundary_config_missing_with_local_subtitle_settings(tmp_path, monkeypatch):
    catalog_path = tmp_path / "catalog.yaml"
    cookies_path = tmp_path / "cookies.txt"
    catalog_path.write_text("countries:\n  - code: ecuador\n    terms:\n      - Ecuador\nplayers: []\n", encoding="utf-8")
    cookies_path.write_text("local cookies must not be read\n", encoding="utf-8")
    settings = Settings(
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=catalog_path,
        network_mode="protected",
        network_boundary_url="",
        network_boundary_token="",
        ai_rescue_enabled=True,
        ai_rescue_worker_enabled=True,
        ai_rescue_opencode_model="gpt-test",
        ai_rescue_opencode_api_key="opencode-token",
        ai_rescue_yt_dlp_cookies_path=cookies_path,
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    def forbidden_local_provider(*args, **kwargs):
        raise AssertionError("local subtitle provider constructed when boundary config is missing")

    monkeypatch.setattr(main_module, "YouTubeTranscriptSubtitleProvider", forbidden_local_provider)
    monkeypatch.setattr(main_module, "YtDlpSubtitleProvider", forbidden_local_provider)

    try:
        main_module._build_ai_rescue_worker(settings=settings, store=store)
    except BoundaryRequestError as exc:
        assert exc.code == "boundary_misconfigured"
    else:
        raise AssertionError("protected AI Rescue builder must fail closed when boundary config is missing")


def test_local_dev_builders_keep_explicit_local_provider_path(tmp_path):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text("countries:\n  - code: ecuador\n    terms:\n      - Ecuador\nplayers: []\n", encoding="utf-8")
    settings = Settings(
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=catalog_path,
        network_mode="local_dev",
        youtube_api_key="youtube-key",
        callback_url="https://monitor.example.test/api/monitor/websub",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()

    resolver = main_module._build_channel_resolver(settings=settings)
    discovery = main_module._build_discovery_worker(settings=settings, store=store)
    websub = main_module._build_websub_worker(settings=settings, store=store)

    assert resolver.__class__.__name__ == "YouTubeDataClient"
    assert discovery.youtube.__class__.__name__ == "YouTubeDataClient"
    assert websub.websub.__class__.__name__ == "WebSubClient"


def test_health_requires_api_key_and_redacts_secrets(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@lequipe
        label: L'Équipe
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        channels_config_path=channels_path,
        radar_api_key="radar-secret",
        youtube_api_key="youtube-secret",
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
      - url: https://www.youtube.com/@lequipe
        label: L'Équipe
      - url: https://www.youtube.com/@lequipe
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
      - url: https://www.youtube.com/@lequipe
        label: L'Équipe
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
      - url: https://www.youtube.com/@lequipe
        label: L'Équipe
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
        "youtube",
        "websub_callback",
        "websub_subscriptions",
        "catchup",
        "cleanup",
        "runtime",
        "classification",
    }
    assert "catchup" in authorized.json()["checks"]["runtime"]["disabled"]


def test_ai_rescue_preflight_is_authenticated_inert_by_default_and_redacts_secrets(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        ai_rescue_enabled=False,
        ai_rescue_worker_enabled=False,
        ai_rescue_opencode_api_key="opencode-secret",
        ai_rescue_opencode_model="gpt-test",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.get("/api/monitor/ai-rescue/preflight")
    authorized = client.get("/api/monitor/ai-rescue/preflight", headers={"x-api-key": "monitor-secret"})

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    body = authorized.json()
    assert body["status"] == "disabled"
    assert body["ready"] is False
    assert body["enabled"] is False
    assert body["worker_enabled"] is False
    assert body["opencode"] == {
        "base_url_configured": True,
        "model_configured": True,
        "api_key_configured": True,
        "api_key_count": 1,
        "multi_key_configured": False,
    }
    assert body["queue_counts"] == {"waiting": 0, "processing": 0, "retry": 0}
    assert body["candidate_count"] == 0
    assert body["rejection_count"] == 0
    assert "opencode-secret" not in authorized.text


def test_ai_rescue_preflight_reports_degraded_worker_reasons_and_runtime_state(tmp_path):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text(
        """
countries:
  - code: ecuador
    terms: [ecuador]
players: []
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=catalog_path,
        ai_rescue_enabled=True,
        ai_rescue_worker_enabled=True,
        ai_rescue_opencode_model="deepseek-v4-flash",
        ai_rescue_opencode_api_key="",
        worker_enqueue_enabled=False,
        worker_pending_live_enabled=False,
        worker_cleanup_enabled=False,
        worker_catchup_enabled=False,
        worker_transcript_sync_enabled=False,
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/ai-rescue/preflight", headers={"x-api-key": "monitor-secret"})
    main_preflight = client.get("/api/monitor/preflight", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["ready"] is False
    assert body["worker_ready"] is False
    assert body["degraded_reasons"] == ["opencode_api_key_missing", "runtime_loop_disabled"]
    assert body["runtime"] == {"enabled": False, "running": False}
    assert body["opencode"]["api_key_configured"] is False
    assert body["opencode"]["api_key_count"] == 0
    assert "ai_rescue" in main_preflight.json()["checks"]["runtime"]["disabled"]


def test_ai_rescue_preflight_reports_multi_key_count_without_secret_values(tmp_path):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text(
        """
countries:
  - code: ecuador
    terms: [ecuador]
players: []
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=catalog_path,
        ai_rescue_enabled=True,
        ai_rescue_worker_enabled=True,
        ai_rescue_opencode_model="deepseek-v4-flash",
        ai_rescue_opencode_api_keys=["opencode-secret-1", "opencode-secret-2"],
        worker_enqueue_enabled=False,
        worker_pending_live_enabled=False,
        worker_cleanup_enabled=False,
        worker_catchup_enabled=False,
        worker_transcript_sync_enabled=False,
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/ai-rescue/preflight", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    body = response.json()
    assert body["opencode"]["api_key_configured"] is True
    assert body["opencode"]["api_key_count"] == 2
    assert body["opencode"]["multi_key_configured"] is True
    assert "opencode-secret-1" not in response.text
    assert "opencode-secret-2" not in response.text


def test_ai_rescue_preflight_reports_missing_model_and_catalog_without_enabling_runtime(tmp_path):
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        catalog_config_path=tmp_path / "missing-catalog.yaml",
        ai_rescue_enabled=True,
        ai_rescue_worker_enabled=True,
        ai_rescue_opencode_model="",
        ai_rescue_opencode_api_key="configured-secret",
        worker_enqueue_enabled=False,
        worker_pending_live_enabled=False,
        worker_cleanup_enabled=False,
        worker_catchup_enabled=False,
        worker_transcript_sync_enabled=False,
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/ai-rescue/preflight", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["degraded_reasons"] == ["opencode_model_missing", "catalog_missing", "runtime_loop_disabled"]
    assert body["catalog"]["configured"] is False
    assert body["runtime"]["enabled"] is False
    assert "configured-secret" not in response.text


def test_ai_rescue_preflight_uses_counts_without_loading_candidates_or_rejections(tmp_path, monkeypatch):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", ai_rescue_enabled=True)
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="trash-1",
            channel_id=channel.id,
            title="Elogio a Ecuador",
            lifecycle="ignored_seen",
            detected_at="2099-01-01T00:00:00Z",
        )
    )
    store.upsert_rejected_video(video_id="trash-1", source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id="trash-1", now="2099-01-01T00:00:00Z")
    store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="trash-1",
        target_country="ecuador",
        score=86,
        summary_es="Hablan de Ecuador.",
        angle_es="Ecuador recibe elogios.",
        risk="low",
    )
    store.store_ai_rescue_rejection(
        queue_id=queue_item.id,
        video_id="trash-1",
        target_country="mexico",
        source="ai",
        reason="weak-evidence",
    )
    monkeypatch.setattr(store, "list_ai_rescue_candidates", lambda **_: (_ for _ in ()).throw(AssertionError("loaded candidates")))
    monkeypatch.setattr(store, "list_ai_rescue_rejections", lambda **_: (_ for _ in ()).throw(AssertionError("loaded rejections")))
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/ai-rescue/preflight", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    body = response.json()
    assert body["candidate_count"] == 1
    assert body["rejection_count"] == 1


def test_ai_rescue_read_endpoints_are_unavailable_when_feature_is_disabled(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", ai_rescue_enabled=False)
    store, candidate_id = _seed_ai_rescue_candidate(tmp_path, settings=settings, target_country="ecuador")
    store.store_ai_rescue_rejection(
        queue_id=1,
        video_id="trash-approve",
        target_country="mexico",
        source="ai",
        reason="weak-evidence",
        details_json='{"explanation_es":"Mención débil"}',
    )
    client = TestClient(create_app(settings=settings, store=store))

    responses = [
        client.get("/api/monitor/ai-rescue/queue", headers={"x-api-key": "monitor-secret"}),
        client.get("/api/monitor/ai-rescue/candidates", headers={"x-api-key": "monitor-secret"}),
        client.get(f"/api/monitor/ai-rescue/candidates/{candidate_id}", headers={"x-api-key": "monitor-secret"}),
        client.get("/api/monitor/ai-rescue/rejections", headers={"x-api-key": "monitor-secret"}),
    ]

    assert [response.status_code for response in responses] == [403, 403, 403, 403]
    assert [response.json()["detail"]["code"] for response in responses] == [
        "ai_rescue_disabled",
        "ai_rescue_disabled",
        "ai_rescue_disabled",
        "ai_rescue_disabled",
    ]


def test_ai_rescue_mutations_are_inert_when_feature_is_disabled(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", ai_rescue_enabled=False)
    store, candidate_id = _seed_ai_rescue_candidate(tmp_path, settings=settings, target_country="ecuador")
    client = TestClient(create_app(settings=settings, store=store))

    approved = client.post(
        f"/api/monitor/ai-rescue/candidates/{candidate_id}/approve",
        headers={"x-api-key": "monitor-secret"},
        json={"confirmed": True, "reviewer": "tester"},
    )
    rejected = client.post(
        f"/api/monitor/ai-rescue/candidates/{candidate_id}/reject",
        headers={"x-api-key": "monitor-secret"},
        json={"confirmed": True, "reason": "No alcanza", "reviewer": "tester"},
    )

    assert approved.status_code == 403
    assert approved.json()["detail"]["code"] == "ai_rescue_disabled"
    assert rejected.status_code == 403
    assert rejected.json()["detail"]["code"] == "ai_rescue_disabled"
    assert store.list_target_matches(video_id="trash-approve") == []
    assert [candidate.id for candidate in store.list_ai_rescue_candidates()] == [candidate_id]
    assert store.list_ai_rescue_rejections() == []


def test_ai_rescue_queue_candidates_detail_and_rejections_contracts_are_sorted_and_read_only(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", ai_rescue_enabled=True)
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="trash-1",
            channel_id=channel.id,
            title="Elogios a Ecuador y México",
            url="https://youtu.be/trash-1",
            published_at="2026-05-21T12:00:00Z",
            lifecycle="ignored_seen",
        )
    )
    store.upsert_rejected_video(video_id="trash-1", source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id="trash-1", now="2026-05-22T10:00:00Z")
    low = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="trash-1",
        target_country="mexico",
        score=54,
        summary_es="Mención positiva moderada a México.",
        angle_es="Ángulo mexicano.",
        risk="medium",
        risks_json='["contexto limitado"]',
        evidence=[
            {
                "start_ms": 2000,
                "end_ms": 24000,
                "text": "Mexico deserve credit",
                "translation_es": "México merece crédito",
                "explanation_es": "Elogio futbolístico explícito.",
            }
        ],
        raw_response_json='{"candidates":[{"target_country":"mexico"}]}',
    )
    high = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="trash-1",
        target_country="ecuador",
        score=91,
        summary_es="Ecuador recibe elogios fuertes.",
        angle_es="Ángulo ecuatoriano.",
        risk="low",
        risks_json="[]",
        evidence=[
            {
                "start_ms": 1000,
                "end_ms": 23000,
                "text": "Ecuador played beautifully",
                "translation_es": "Ecuador jugó hermoso",
                "explanation_es": "Elogio futbolístico explícito.",
            }
        ],
        raw_response_json='{"candidates":[{"target_country":"ecuador"}]}',
    )
    store.store_ai_rescue_rejection(
        queue_id=queue_item.id,
        video_id="trash-1",
        target_country="argentina",
        source="ai",
        reason="weak-evidence",
        details_json='{"explanation_es":"Mención débil"}',
    )
    before_matches = store.list_target_matches(video_id="trash-1")
    client = TestClient(create_app(settings=settings, store=store))

    queue_response = client.get("/api/monitor/ai-rescue/queue", headers={"x-api-key": "monitor-secret"})
    candidates_response = client.get("/api/monitor/ai-rescue/candidates", headers={"x-api-key": "monitor-secret"})
    detail_response = client.get(
        f"/api/monitor/ai-rescue/candidates/{high.id}", headers={"x-api-key": "monitor-secret"}
    )
    rejected_response = client.get("/api/monitor/ai-rescue/rejections", headers={"x-api-key": "monitor-secret"})
    after_matches = store.list_target_matches(video_id="trash-1")

    assert queue_response.status_code == 200
    assert queue_response.json()["counts"] == {"waiting": 0, "processing": 0, "retry": 0}
    assert candidates_response.status_code == 200
    assert [item["id"] for item in candidates_response.json()["items"]] == [high.id, low.id]
    assert candidates_response.json()["summary"] == {"candidate_count": 2, "rejection_count": 1, "by_country": {"ecuador": 1, "mexico": 1}}
    assert candidates_response.json()["items"][0]["score"] == 91
    assert candidates_response.json()["items"][0]["target_country_label"] == "Ecuador"
    assert detail_response.status_code == 200
    assert detail_response.json()["evidence"] == [
        {
            "start_ms": 1000,
            "end_ms": 23000,
            "text": "Ecuador played beautifully",
            "translation_es": "Ecuador jugó hermoso",
            "explanation_es": "Elogio futbolístico explícito.",
        }
    ]
    assert rejected_response.status_code == 200
    assert rejected_response.json()["items"][0]["source"] == "ai"
    assert before_matches == after_matches


def test_ai_rescue_queue_and_rejections_expose_spanish_operator_labels(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", ai_rescue_enabled=True)
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    for video_id, reason in [
        ("queue-no-subtitles", "no-subtitles"),
        ("queue-timeout", "opencode_timeout"),
        ("queue-technical", "opencode_server_error"),
        ("reject-off", "transcripts_disabled"),
        ("reject-unavailable", "video_unavailable"),
    ]:
        store.upsert_video(VideoRecord(video_id=video_id, channel_id=channel.id, title=video_id, lifecycle="ignored_seen"))
        store.upsert_rejected_video(video_id=video_id, source_country="colombia", reason="no_valid_target_match")
        queue_item = store.enqueue_ai_rescue_rejected_video(video_id=video_id, now="2026-05-22T10:00:00Z")
        if video_id.startswith("queue-"):
            store.schedule_ai_rescue_retry(queue_item.id, now="2026-05-22T10:01:00Z", next_attempt_at="2026-05-22T10:00:00Z", last_error=reason)
        else:
            store.reject_ai_rescue_queue_item(queue_item.id, now="2026-05-22T10:01:00Z", source="system", reason=reason)
    client = TestClient(create_app(settings=settings, store=store))

    queue_response = client.get("/api/monitor/ai-rescue/queue", headers={"x-api-key": "monitor-secret"})
    rejected_response = client.get("/api/monitor/ai-rescue/rejections", headers={"x-api-key": "monitor-secret"})

    assert queue_response.status_code == 200
    queue_labels = {item["video_id"]: (item["last_error"], item["failure_code"], item["display_status"]) for item in queue_response.json()["upcoming"]}
    assert queue_labels == {
        "queue-no-subtitles": ("no-subtitles", "no_subtitles", "SIN SUBTÍTULOS"),
        "queue-timeout": ("opencode_timeout", "opencode_timeout", "TIMEOUT"),
        "queue-technical": ("opencode_server_error", "opencode_server_error", "FALLO TÉCNICO"),
    }
    assert rejected_response.status_code == 200
    rejection_labels = {item["video_id"]: (item["reason"], item["failure_code"], item["display_status"]) for item in rejected_response.json()["items"]}
    assert rejection_labels == {
        "reject-off": ("transcripts_disabled", "transcripts_disabled", "SUBTÍTULOS OFF"),
        "reject-unavailable": ("video_unavailable", "video_unavailable", "NO DISPONIBLE"),
    }


def test_card_dismissal_endpoint_filters_ai_rescue_candidate_context_without_decision(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", ai_rescue_enabled=True)
    store, candidate_id = _seed_ai_rescue_candidate(tmp_path, settings=settings, target_country="ecuador")
    client = TestClient(create_app(settings=settings, store=store))

    dismissed = client.post(
        "/api/monitor/card-dismissals",
        headers={"x-api-key": "monitor-secret"},
        json={
            "surface": "ai-rescue-candidate",
            "target_context": "ecuador",
            "video_id": "trash-approve",
            "candidate_id": candidate_id,
            "reason": "operator-dismissed",
        },
    )
    candidates = client.get("/api/monitor/ai-rescue/candidates", headers={"x-api-key": "monitor-secret"})

    assert dismissed.status_code == 200
    assert dismissed.json() == {"status": "dismissed", "context_key": f"ai-rescue-candidate:ecuador:{candidate_id}"}
    assert candidates.status_code == 200
    assert candidates.json()["items"] == []
    assert store.get_ai_rescue_candidate(candidate_id).status == "candidate"
    assert store.list_target_matches(video_id="trash-approve") == []


def test_ai_rescue_refresh_enqueues_rejected_videos_only_when_enabled_without_external_calls(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", ai_rescue_enabled=True)
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="refresh-trash", channel_id=channel.id, title="Solo Colombia", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="refresh-trash", source_country="colombia", reason="no_valid_target_match")
    enabled_client = TestClient(create_app(settings=settings, store=store))

    first = enabled_client.post("/api/monitor/ai-rescue/refresh", headers={"x-api-key": "monitor-secret"})
    second = enabled_client.post("/api/monitor/ai-rescue/refresh", headers={"x-api-key": "monitor-secret"})
    disabled_client = TestClient(
        create_app(settings=Settings(api_key="monitor-secret", db_path=settings.db_path), store=store)
    )
    disabled = disabled_client.post("/api/monitor/ai-rescue/refresh", headers={"x-api-key": "monitor-secret"})

    assert first.status_code == 200
    assert first.json() == {"status": "ok", "enqueued_count": 1}
    assert second.status_code == 200
    assert second.json() == {"status": "ok", "enqueued_count": 0}
    assert disabled.status_code == 200
    assert disabled.json() == {"status": "disabled", "enqueued_count": 0}
    assert [item.video_id for item in store.list_ai_rescue_queue(limit=10)] == ["refresh-trash"]


def test_ai_rescue_human_reject_requires_confirmation_hides_candidate_and_lists_rejection(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", ai_rescue_enabled=True)
    store, candidate_id = _seed_ai_rescue_candidate(tmp_path, settings=settings, target_country="ecuador")
    client = TestClient(create_app(settings=settings, store=store))

    missing_confirmation = client.post(
        f"/api/monitor/ai-rescue/candidates/{candidate_id}/reject",
        headers={"x-api-key": "monitor-secret"},
        json={"reason": "No alcanza para publicar"},
    )
    rejected = client.post(
        f"/api/monitor/ai-rescue/candidates/{candidate_id}/reject",
        headers={"x-api-key": "monitor-secret"},
        json={"confirmed": True, "reason": "No alcanza para publicar", "reviewer": "tester"},
    )
    candidates = client.get("/api/monitor/ai-rescue/candidates", headers={"x-api-key": "monitor-secret"})
    rejections = client.get("/api/monitor/ai-rescue/rejections", headers={"x-api-key": "monitor-secret"})

    assert missing_confirmation.status_code == 400
    assert missing_confirmation.json()["detail"]["code"] == "confirmation_required"
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert candidates.json()["items"] == []
    assert rejections.json()["items"] == [
        {
            "id": 1,
            "video_id": "trash-approve",
            "candidate_id": candidate_id,
            "target_country": "ecuador",
            "target_country_label": "Ecuador",
            "source": "human",
            "reason": "No alcanza para publicar",
            "details": None,
        }
    ]


def test_ai_rescue_human_approve_promotes_to_radar_without_widening_rules(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", ai_rescue_enabled=True)
    store, approved_candidate_id = _seed_ai_rescue_candidate(tmp_path, settings=settings, target_country="ecuador")
    _, same_country_candidate_id = _seed_ai_rescue_candidate(
        tmp_path, settings=settings, target_country="colombia", video_id="trash-same-country"
    )
    client = TestClient(create_app(settings=settings, store=store))

    missing_confirmation = client.post(
        f"/api/monitor/ai-rescue/candidates/{approved_candidate_id}/approve",
        headers={"x-api-key": "monitor-secret"},
        json={"reviewer": "tester"},
    )
    same_country = client.post(
        f"/api/monitor/ai-rescue/candidates/{same_country_candidate_id}/approve",
        headers={"x-api-key": "monitor-secret"},
        json={"confirmed": True, "reviewer": "tester"},
    )
    approved = client.post(
        f"/api/monitor/ai-rescue/candidates/{approved_candidate_id}/approve",
        headers={"x-api-key": "monitor-secret"},
        json={"confirmed": True, "reviewer": "tester"},
    )
    candidates = client.get("/api/monitor/ai-rescue/candidates", headers={"x-api-key": "monitor-secret"})
    radar_cards = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"})

    assert missing_confirmation.status_code == 400
    assert same_country.status_code == 400
    assert same_country.json()["detail"]["code"] == "target_country_matches_source"
    assert approved.status_code == 200
    assert approved.json()["promoted"] == {
        "video_id": "trash-approve",
        "target_country": "ecuador",
        "status": "aprobado",
        "approval_source": "ai_rescue",
        "display_status": "RESCATADO IA",
    }
    assert approved_candidate_id not in [item["id"] for item in candidates.json()["items"]]
    assert radar_cards.json()["items"][0]["status"] == "aprobado"
    assert radar_cards.json()["items"][0]["approval_source"] == "ai_rescue"
    assert radar_cards.json()["items"][0]["display_status"] == "RESCATADO IA"


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
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
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
      - url: https://www.youtube.com/@lequipe
        label: L'Équipe
""".strip(),
        encoding="utf-8",
    )
    settings = Settings(
        api_key="monitor-secret",
        db_path=tmp_path / "monitor.sqlite3",
        channels_config_path=channels_path,
        radar_url="http://127.0.0.1:8765",
        radar_api_key="radar-secret",
        youtube_api_key="youtube-secret",
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
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
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
    store.upsert_target_match(TargetMatchRecord(video_id="expired-api", target_country="ecuador", status="transcribiendo", radar_job_id="job-api"))
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
        youtube_api_key="youtube-secret",
        callback_secret="callback-secret",
    )
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="ecuador", label="El Canal", source_url=None, youtube_channel_id="UCEcuador")
    )
    store.upsert_video(
        VideoRecord(
            video_id="ecuador-video",
            channel_id=channel.id,
            title="Ecuador gana el partido",
            url="https://youtu.be/ecuador-video",
            published_at="2026-05-21T15:30:00Z",
            lifecycle="enqueue_pending",
            matched=True,
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="ecuador-video",
            target_country="ecuador",
            status="transcribiendo",
            radar_job_id="radar-job-ec",
        )
    )
    store.record_enqueue_attempt(video_id="ecuador-video", status="submitted", radar_job_id="radar-job-ec")
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.get("/api/monitor/cards")
    before_attempts = store.list_enqueue_attempts("ecuador-video")
    authorized = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"})
    after_attempts = store.list_enqueue_attempts("ecuador-video")

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
    assert authorized.json() == {
        "status": "ok",
        "degraded": False,
        "items": [
            {
                "id": "ecuador-video:ecuador",
                "video_id": "ecuador-video",
                "title": "Ecuador gana el partido",
                "url": "https://youtu.be/ecuador-video",
                "target_country": "ecuador",
                "target_country_label": "Ecuador",
                "source_country": "ecuador",
                "source_country_label": "Ecuador",
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
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", uploads_playlist_id="UUCaracol"))
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
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", uploads_playlist_id="UUCaracol"))
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
        ChannelRecord(country="argentina", label="TyC", source_url=None, youtube_channel_id="UCTyC")
    )
    store.upsert_video(
        VideoRecord(
            video_id="argentina-unlinked",
            channel_id=channel.id,
            title="Video pendiente de Radar",
            url="https://youtu.be/argentina-unlinked",
            published_at="2026-05-21T17:00:00Z",
            lifecycle="discovered",
            matched=True,
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(video_id="argentina-unlinked", target_country="argentina", status="aprobado")
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"})

    assert response.status_code == 200
    assert response.json()["items"] == [
        {
            "id": "argentina-unlinked:argentina",
            "video_id": "argentina-unlinked",
            "title": "Video pendiente de Radar",
            "url": "https://youtu.be/argentina-unlinked",
            "target_country": "argentina",
            "target_country_label": "Argentina",
            "source_country": "argentina",
            "source_country_label": "Argentina",
            "channel_label": "TyC",
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
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
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
            target_country="ecuador",
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
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    cases = [
        ("bot-video", "ecuador", "yt_dlp_bot_check", "BLOQUEO YOUTUBE"),
        ("live-video", "mexico", "yt_dlp_live_pending", "LIVE PENDIENTE"),
        ("copy-video", "argentina", "yt_dlp_copyright_blocked", "COPYRIGHT"),
        ("timeout-video", "uruguay", "yt_dlp_timeout", "TIMEOUT"),
        ("private-video", "paraguay", "yt_dlp_private_or_removed", "NO DISPONIBLE"),
        ("technical-video", "colombia", "ffmpeg_failed", "FALLO TÉCNICO"),
        ("unknown-video", "ecuador", "provider_new_failure", "ERROR"),
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
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="multi",
            channel_id=channel.id,
            title="Ecuador y México",
            url="https://youtu.be/multi",
            published_at="2026-05-21T18:00:00Z",
            lifecycle="enqueued",
            matched=True,
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="multi",
            target_country="mexico",
            status="transcrito",
            radar_job_id="radar-1",
            mention_counts_json='[{"label":"México","count":2},{"label":"Cero","count":0}]',
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="multi",
            target_country="ecuador",
            status="aprobado",
            radar_job_id="radar-1",
        )
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "mexico"})

    assert response.status_code == 200
    assert response.json()["items"] == [
        {
            "id": "multi:mexico",
            "video_id": "multi",
            "title": "Ecuador y México",
            "url": "https://youtu.be/multi",
            "target_country": "mexico",
            "target_country_label": "México",
            "source_country": "colombia",
            "source_country_label": "Colombia",
            "channel_label": "Caracol",
            "published_at": "2026-05-21T18:00:00Z",
            "status": "transcrito",
            "approval_source": "title_classifier",
            "display_status": "TRANSCRITO",
            "radar_job_id": "radar-1",
            "last_error": None,
            "mention_status": "ready",
            "mention_counts": [{"label": "México", "count": 2}],
            "classification_version": "title-country-v1",
        }
    ]


def test_card_dismissal_endpoint_requires_auth_validates_payload_and_filters_cards_summary(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", important=True)
    )
    store.upsert_video(
        VideoRecord(
            video_id="multi-dismiss",
            channel_id=channel.id,
            title="Ecuador y Colombia",
            url="https://youtu.be/multi-dismiss",
            published_at="2026-05-21T18:00:00Z",
            lifecycle="enqueued",
            matched=True,
            classification_status="important_channel",
        )
    )
    store.upsert_target_match(TargetMatchRecord(video_id="multi-dismiss", target_country="ecuador", status="aprobado"))
    store.upsert_target_match(TargetMatchRecord(video_id="multi-dismiss", target_country="colombia", status="transcrito"))
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.post(
        "/api/monitor/card-dismissals",
        json={"surface": "monitor-card", "target_context": "ecuador", "video_id": "multi-dismiss"},
    )
    invalid = client.post(
        "/api/monitor/card-dismissals",
        headers={"x-api-key": "monitor-secret"},
        json={"surface": "monitor-card", "target_context": "ecuador"},
    )
    dismissed = client.post(
        "/api/monitor/card-dismissals",
        headers={"x-api-key": "monitor-secret"},
        json={
            "surface": "monitor-card",
            "target_context": "Ecuador",
            "video_id": "multi-dismiss",
            "reason": "operator-dismissed",
            "dismissed_by": "control-panel",
        },
    )
    ecuador = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "ecuador"})
    colombia = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "colombia"})
    important = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "important"})
    summary = client.get("/api/monitor/summary", headers={"x-api-key": "monitor-secret"})

    assert unauthorized.status_code == 401
    assert invalid.status_code == 400
    assert invalid.json()["detail"]["code"] == "missing_dismissal_subject"
    assert dismissed.status_code == 200
    assert dismissed.json() == {"status": "dismissed", "context_key": "monitor-card:ecuador:multi-dismiss"}
    assert ecuador.json()["items"] == []
    assert ecuador.json()["pagination"]["total"] == 0
    assert [item["video_id"] for item in colombia.json()["items"]] == ["multi-dismiss"]
    assert [item["video_id"] for item in important.json()["items"]] == ["multi-dismiss"]
    ecuador_counts = next(item for item in summary.json()["targets"] if item["country"] == "ecuador")
    colombia_counts = next(item for item in summary.json()["targets"] if item["country"] == "colombia")
    assert ecuador_counts["aprobado"] == 0
    assert colombia_counts["transcrito"] == 1


def test_monitor_cards_endpoint_marks_transcribed_zero_mentions_as_ready(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="zero-mentions",
            channel_id=channel.id,
            title="México sin menciones finales",
            url="https://youtu.be/zero-mentions",
            published_at="2026-05-21T19:00:00Z",
            lifecycle="enqueued",
            matched=True,
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="zero-mentions",
            target_country="mexico",
            status="transcrito",
            radar_job_id="radar-zero",
            mention_counts_json="[]",
        )
    )
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "mexico"})

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
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(video_id="ecuador-target", channel_id=channel.id, title="Ecuador candidato", lifecycle="enqueued")
    )
    store.upsert_target_match(TargetMatchRecord(video_id="ecuador-target", target_country="ecuador", status="aprobado"))
    store.upsert_video(
        VideoRecord(
            video_id="legacy-only",
            channel_id=channel.id,
            title="Legacy Colombia card",
            lifecycle="enqueue_pending",
            matched=True,
        )
    )
    store.record_enqueue_attempt(video_id="legacy-only", status="submitted", radar_job_id="legacy-job")
    client = TestClient(create_app(settings=settings, store=store))

    response = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "mexico"})

    assert response.status_code == 200
    assert response.json()["items"] == []


def test_monitor_cards_endpoint_derives_important_view_from_channel_membership_without_target_rows(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    important_channel = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports",
            source_url=None,
            youtube_channel_id="UCImportant",
            important=True,
            priority_tier="importantes",
        )
    )
    normal_channel = store.upsert_channel(
        ChannelRecord(country="mexico", label="Normal", source_url=None, youtube_channel_id="UCNormal")
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
    store.upsert_target_match(TargetMatchRecord(video_id="normal-api", target_country="mexico", status="transcrito"))
    client = TestClient(create_app(settings=settings, store=store))

    important = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "important"})
    mexico = client.get("/api/monitor/cards", headers={"x-api-key": "monitor-secret"}, params={"target_country": "mexico"})

    assert important.status_code == 200
    assert important.json()["items"] == [
        {
            "id": "important-zero-api:important",
            "video_id": "important-zero-api",
            "title": "Important without country mentions",
            "url": "https://youtu.be/important-zero-api",
            "target_country": "important",
            "target_country_label": "IMPORTANTES",
            "source_country": "argentina",
            "source_country_label": "Argentina",
            "channel_label": "NSports",
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
    assert [item["video_id"] for item in mexico.json()["items"]] == ["normal-api"]
    assert store.list_target_matches(video_id="important-zero-api") == []


def test_monitor_cards_endpoint_adds_important_audit_fields_without_removing_legacy_fields(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="mexico",
            label="ESPN MX",
            source_url=None,
            youtube_channel_id="UCESPNMX",
            important_mode="program_rules",
        )
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-program-api",
            channel_id=channel.id,
            title="Fútbol Picante EN VIVO",
            url="https://youtu.be/important-program-api",
            published_at="2026-05-27T13:00:00Z",
            lifecycle="enqueued",
            matched=True,
            classification_status="important",
            classification_reason="important_program_match",
            classification_version="important-v2",
            important_mode="program_rules",
            important_rule_json='{"op":"contains","value":"FUTBOL PICANTE","normalized_value":"FUTBOL PICANTE"}',
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
    assert item["important_rule"] == {"op": "contains", "value": "FUTBOL PICANTE", "normalized_value": "FUTBOL PICANTE"}
    assert item["source_country"] == "mexico"
    assert item["source_country_label"] == "México"
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
            country="uruguay",
            label="Fútbol Libre",
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
            important_rule_json='{"type":"important_full_channel","label":"Fútbol Libre"}',
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
    assert response.json()["items"][0]["important_rule"] == {"type": "important_full_channel", "label": "Fútbol Libre"}
    assert store.list_target_matches(video_id="geo-important-api") == []


def test_monitor_cards_endpoint_excludes_expired_important_videos_by_detected_at(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3", radar_api_key="radar-secret")
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="argentina", label="NSports", source_url=None, youtube_channel_id="UCImportant", important=True)
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
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(video_id="basura-only", channel_id=channel.id, title="Solo Colombia", lifecycle="ignored_seen")
    )
    store.upsert_rejected_video(
        video_id="basura-only",
        source_country="colombia",
        reason="no_valid_target_match",
        match_reason_json='[{"country":"colombia"}]',
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
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="approved", channel_id=channel.id, title="Ecuador", lifecycle="enqueue_pending"))
    store.upsert_target_match(TargetMatchRecord(video_id="approved", target_country="ecuador", status="aprobado"))
    store.upsert_video(VideoRecord(video_id="trash", channel_id=channel.id, title="Solo Colombia", lifecycle="ignored_seen"))
    store.upsert_rejected_video(
        video_id="trash",
        source_country="colombia",
        reason="no_valid_target_match",
        match_reason_json='[{"country":"colombia"}]',
    )
    client = TestClient(create_app(settings=settings, store=store))

    unauthorized = client.get("/api/monitor/basura")
    summary = client.get("/api/monitor/summary", headers={"x-api-key": "monitor-secret"})
    basura = client.get("/api/monitor/basura", headers={"x-api-key": "monitor-secret"})

    assert unauthorized.status_code == 401
    assert summary.status_code == 200
    assert summary.json()["basura_count"] == 1
    assert [(item["country"], item["aprobado"]) for item in summary.json()["targets"]][:2] == [
        ("ecuador", 1),
        ("colombia", 0),
    ]
    assert basura.status_code == 200
    assert basura.json()["total"] == 1
    assert basura.json()["items"] == [
        {
            "video_id": "trash",
            "title": "Solo Colombia",
            "url": None,
            "source_country": "colombia",
            "source_country_label": "Colombia",
            "channel_label": "Caracol",
            "published_at": None,
            "reason": "no_valid_target_match",
            "match_reasons": [{"country": "colombia"}],
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
            channel_id="UClequipeStable",
            title="L'Équipe",
            uploads_playlist_id="UUlequipeStable",
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
        json={"country": "fr", "label": "L'Équipe API", "url": "https://www.youtube.com/@lequipe"},
    )
    list_response = client.get("/api/monitor/channels", headers={"x-api-key": "monitor-secret"})
    channel_id = add_response.json()["id"]
    update_response = client.patch(
        f"/api/monitor/channels/{channel_id}",
        headers={"x-api-key": "monitor-secret"},
        json={"label": "L'Équipe disabled", "enabled": False},
    )

    assert unauthorized.status_code == 401
    assert add_response.status_code == 201
    assert resolver.calls == ["https://www.youtube.com/@lequipe"]
    assert add_response.json() == {
        "id": channel_id,
        "country": "fr",
        "label": "L'Équipe API",
        "source_url": "https://www.youtube.com/@lequipe",
        "youtube_channel_id": "UClequipeStable",
        "uploads_playlist_id": "UUlequipeStable",
        "enabled": True,
    }
    assert list_response.status_code == 200
    assert list_response.json()["channels"][0]["youtube_channel_id"] == "UClequipeStable"
    assert update_response.status_code == 200
    assert update_response.json()["label"] == "L'Équipe disabled"
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


def test_preflight_reports_configured_channels_without_syncing_handle_urls(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@lequipe
        label: L'Équipe configured
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


def _seed_ai_rescue_candidate(
    tmp_path,
    *,
    settings: Settings,
    target_country: str,
    video_id: str = "trash-approve",
) -> tuple[MonitorStore, int]:
    store = MonitorStore(settings.db_path)
    store.migrate()
    channel = store.find_channel_by_youtube_id("UCCaracol") or store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    if store.get_video(video_id) is None:
        store.upsert_video(
            VideoRecord(
                video_id=video_id,
                channel_id=channel.id,
                title="Elogio internacional",
                url=f"https://youtu.be/{video_id}",
                published_at="2026-05-21T12:00:00Z",
                lifecycle="enqueue_pending",
                matched=True,
            )
        )
        store.upsert_rejected_video(video_id=video_id, source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id=video_id, now="2026-05-22T10:00:00Z")
    candidate = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id=video_id,
        target_country=target_country,
        score=88,
        summary_es="El video elogia al país objetivo.",
        angle_es="Ángulo editorial claro.",
        risk="low",
        risks_json="[]",
        evidence=[
            {
                "start_ms": 1000,
                "end_ms": 23000,
                "text": "They played beautifully",
                "translation_es": "Jugaron hermoso",
                "explanation_es": "Elogio futbolístico explícito.",
            }
        ],
        raw_response_json="{}",
    )
    return store, candidate.id
