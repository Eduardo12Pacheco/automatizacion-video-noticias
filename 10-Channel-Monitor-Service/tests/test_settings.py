from __future__ import annotations

from pathlib import Path

from app.settings import load_channel_config, load_settings, validate_channel_config


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def test_load_settings_reads_monitor_environment(monkeypatch, tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    channels_path = tmp_path / "channels.yaml"
    catalog_path = tmp_path / "catalog.yaml"
    monkeypatch.setenv("CHANNEL_MONITOR_API_KEY", "monitor-secret")
    monkeypatch.setenv("CHANNEL_MONITOR_DB_PATH", str(db_path))
    monkeypatch.setenv("CHANNEL_MONITOR_CHANNELS_CONFIG", str(channels_path))
    monkeypatch.setenv("CHANNEL_MONITOR_CATALOG_CONFIG", str(catalog_path))
    monkeypatch.setenv("CHANNEL_MONITOR_RADAR_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("CHANNEL_MONITOR_RADAR_API_KEY", "radar-secret")
    monkeypatch.setenv("CHANNEL_MONITOR_CALLBACK_URL", "https://example.test/websub")
    monkeypatch.setenv("CHANNEL_MONITOR_CALLBACK_SECRET", "callback-secret")
    monkeypatch.setenv("CHANNEL_MONITOR_YOUTUBE_API_KEY", "youtube-secret")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_ENQUEUE_ENABLED", "false")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_ENQUEUE_INTERVAL_SECONDS", "7")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_PENDING_LIVE_ENABLED", "true")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_PENDING_LIVE_INTERVAL_SECONDS", "13")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_CLEANUP_ENABLED", "false")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_CLEANUP_INTERVAL_SECONDS", "23")
    monkeypatch.setenv("CHANNEL_MONITOR_CLEANUP_RETENTION_HOURS", "120")
    monkeypatch.setenv("CHANNEL_MONITOR_CLEANUP_MODE", "dry-run")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_WEBSUB_ENABLED", "true")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_WEBSUB_INTERVAL_SECONDS", "31")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_CATCHUP_ENABLED", "false")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_CATCHUP_INTERVAL_SECONDS", "37")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_TRANSCRIPT_SYNC_ENABLED", "false")
    monkeypatch.setenv("CHANNEL_MONITOR_WORKER_TRANSCRIPT_SYNC_INTERVAL_SECONDS", "17")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_ENABLED", "true")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_WORKER_ENABLED", "true")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_WORKER_INTERVAL_SECONDS", "19")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_RETRY_ATTEMPTS", "5")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_RETRY_INTERVAL_SECONDS", "7200")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_OPENCODE_MODEL", "local-model")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_OPENCODE_API_KEY", "opencode-secret")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_OPENCODE_API_KEYS", "opencode-secret-1, opencode-secret-2")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_PROCESSING_TIMEOUT_SECONDS", "900")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_SUBTITLE_MAX_CHARACTERS", "300000")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_SUBTITLE_HARD_MAX_CHARACTERS", "1000000")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_SUBTITLE_MAX_SEGMENTS", "10000")
    monkeypatch.setenv("CHANNEL_MONITOR_CATCHUP_PAGE_LIMIT", "9")
    monkeypatch.setenv("CHANNEL_MONITOR_CATCHUP_ITEM_LIMIT", "321")

    settings = load_settings()

    assert settings.api_key == "monitor-secret"
    assert settings.db_path == db_path
    assert settings.channels_config_path == channels_path
    assert settings.catalog_config_path == catalog_path
    assert settings.radar_url == "http://127.0.0.1:8765"
    assert settings.radar_api_key == "radar-secret"
    assert settings.callback_url == "https://example.test/websub"
    assert settings.callback_secret == "callback-secret"
    assert settings.youtube_api_key == "youtube-secret"
    assert settings.worker_enqueue_enabled is False
    assert settings.worker_enqueue_interval_seconds == 7
    assert settings.worker_pending_live_enabled is True
    assert settings.worker_pending_live_interval_seconds == 13
    assert settings.worker_cleanup_enabled is False
    assert settings.worker_cleanup_interval_seconds == 23
    assert settings.cleanup_retention_hours == 120
    assert settings.cleanup_mode == "dry-run"
    assert settings.worker_websub_enabled is True
    assert settings.worker_websub_interval_seconds == 31
    assert settings.worker_catchup_enabled is False
    assert settings.worker_catchup_interval_seconds == 37
    assert settings.worker_transcript_sync_enabled is False
    assert settings.worker_transcript_sync_interval_seconds == 17
    assert settings.ai_rescue_enabled is True
    assert settings.ai_rescue_worker_enabled is True
    assert settings.ai_rescue_worker_interval_seconds == 19
    assert settings.ai_rescue_retry_attempts == 5
    assert settings.ai_rescue_retry_interval_seconds == 7200
    assert settings.ai_rescue_opencode_base_url == "https://opencode.ai/zen/go/v1"
    assert settings.ai_rescue_opencode_model == "local-model"
    assert settings.ai_rescue_opencode_api_key == "opencode-secret"
    assert settings.ai_rescue_opencode_api_keys == ["opencode-secret-1", "opencode-secret-2"]
    assert settings.ai_rescue_processing_timeout_seconds == 900
    assert settings.ai_rescue_subtitle_max_characters == 300000
    assert settings.ai_rescue_subtitle_hard_max_characters == 1000000
    assert settings.ai_rescue_subtitle_max_segments == 10000
    assert settings.catchup_page_limit == 9
    assert settings.catchup_item_limit == 321


def test_worker_runtime_settings_have_safe_defaults():
    settings = load_settings()

    assert settings.worker_enqueue_enabled is True
    assert settings.worker_enqueue_interval_seconds == 60
    assert settings.worker_pending_live_enabled is True
    assert settings.worker_pending_live_interval_seconds == 300
    assert settings.worker_cleanup_enabled is True
    assert settings.worker_cleanup_interval_seconds == 3600
    assert settings.cleanup_retention_hours == 120
    assert settings.cleanup_mode == "dry-run"
    assert settings.worker_websub_enabled is False
    assert settings.worker_websub_interval_seconds == 86400
    assert settings.worker_catchup_enabled is True
    assert settings.worker_catchup_interval_seconds == 3600
    assert settings.worker_transcript_sync_enabled is True
    assert settings.worker_transcript_sync_interval_seconds == 60
    assert settings.ai_rescue_enabled is False
    assert settings.ai_rescue_worker_enabled is False
    assert settings.ai_rescue_worker_interval_seconds == 5
    assert settings.ai_rescue_retry_attempts == 3
    assert settings.ai_rescue_retry_interval_seconds == 7200
    assert settings.ai_rescue_opencode_base_url == "https://opencode.ai/zen/go/v1"
    assert settings.ai_rescue_opencode_model == ""
    assert settings.ai_rescue_opencode_api_key == ""
    assert settings.ai_rescue_opencode_api_keys == []
    assert settings.ai_rescue_processing_timeout_seconds == 1800
    assert settings.ai_rescue_subtitle_max_characters == 300000
    assert settings.ai_rescue_subtitle_hard_max_characters == 1000000
    assert settings.ai_rescue_subtitle_max_segments == 10000
    assert settings.catchup_page_limit == 20
    assert settings.catchup_item_limit == 1000


def test_load_channel_config_parses_seed_handle_grouped_by_country(tmp_path):
    path = tmp_path / "channels.yaml"
    path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@lequipe
        label: L'Équipe
        enabled: true
""".strip(),
        encoding="utf-8",
    )

    config = load_channel_config(path)

    assert config.countries[0].code == "fr"
    assert config.countries[0].channels[0].url == "https://www.youtube.com/@lequipe"
    assert config.countries[0].channels[0].label == "L'Équipe"
    assert config.countries[0].channels[0].enabled is True


def test_load_channel_config_parses_important_channel_metadata(tmp_path):
    path = tmp_path / "channels.yaml"
    path.write_text(
        """
countries:
  - code: ar
    name: Argentina
    channels:
      - url: https://www.youtube.com/@NSportsGo
        label: NSports
        enabled: true
        important: true
        important_mode: full_channel
        priority_tier: importantes
        algorithm_priority_rank: 1
      - url: https://www.youtube.com/@normal
        label: Normal channel
        algorithm_priority_rank: 9
""".strip(),
        encoding="utf-8",
    )

    config = load_channel_config(path)

    important, normal = config.countries[0].channels
    assert important.important is True
    assert important.important_mode == "full_channel"
    assert important.important_rules == []
    assert important.priority_tier == "importantes"
    assert important.algorithm_priority_rank == 1
    assert normal.important is False
    assert normal.priority_tier is None
    assert normal.algorithm_priority_rank == 9


def test_load_channel_config_parses_program_important_rules_in_order(tmp_path):
    path = tmp_path / "channels.yaml"
    path.write_text(
        """
countries:
  - code: es
    name: España
    channels:
      - url: https://www.youtube.com/@marca
        label: MARCA
        important_mode: program_rules
        important_rules:
          - content_types: [live, completed]
            op: starts_with
            value: LA PIZARRA DE QUINTANA
          - content_types: [completed]
            op: contains
            value: QUINTANA
""".strip(),
        encoding="utf-8",
    )

    config = load_channel_config(path)
    channel = config.countries[0].channels[0]

    assert channel.important is False
    assert channel.important_mode == "program_rules"
    assert [(rule.content_types, rule.op, rule.value) for rule in channel.important_rules] == [
        (["live", "completed"], "starts_with", "LA PIZARRA DE QUINTANA"),
        (["completed"], "contains", "QUINTANA"),
    ]


def test_default_channel_config_marks_full_channel_important_sources_without_pseudo_country():
    config = load_channel_config(SERVICE_ROOT / "config" / "channels.yaml")

    country_codes = {country.code for country in config.countries}
    important_labels = {
        channel.label
        for country in config.countries
        for channel in country.channels
        if channel.important_mode == "full_channel"
    }

    assert "important" not in country_codes
    assert "importantes" not in country_codes
    assert important_labels == {
        "NSports",
        "Jorge Ramos y su Banda",
        "Carlos Antonio Vélez",
        "Samuel Vargas",
        "LA HINCHADA GRITA",
        "Fútbol Libre",
        "Eddie Fleischman",
    }


def test_default_channel_config_keeps_algorithm_priority_separate_from_important():
    config = load_channel_config(SERVICE_ROOT / "config" / "channels.yaml")

    ranked_channels = {
        channel.label: channel
        for country in config.countries
        for channel in country.channels
        if channel.algorithm_priority_rank is not None
    }

    assert ranked_channels["NSports"].important is True
    assert ranked_channels["Mundo Maldini"].important is False
    assert ranked_channels["Mundo Maldini"].algorithm_priority_rank == 11
    assert len(ranked_channels) == 35


def test_default_channel_config_contains_exact_program_rule_sources():
    config = load_channel_config(SERVICE_ROOT / "config" / "channels.yaml")

    rule_sources = {
        channel.label: [(rule.op, rule.value) for rule in channel.important_rules]
        for country in config.countries
        for channel in country.channels
        if channel.important_mode == "program_rules"
    }

    assert rule_sources == {
        "MARCA": [("starts_with", "LA PIZARRA DE QUINTANA")],
        "Exitosa": [("starts_with", "EXITOSA DEPORTES")],
        "Mr Peet": [("starts_with", "MADRUGOL CON MR PEET")],
        "ADN Chile": [("contains", "TENORES")],
        "TNT Sports Chile": [("contains", "TODOS SOMOS TECNICOS")],
        "Círculo Central": [("contains", "CIRCULO CENTRAL")],
        "ABC TV Paraguay": [("starts_with", "#CARDINALDEPORTIVO"), ("contains", "CARDINAL DEPORTIVO")],
        "Rock & Pop Paraguay": [("starts_with", "#LAGRANJUGADA")],
        "TV Azteca": [("contains", "LA MESA PROTAGONISTA")],
        "FOX Sports MX": [("contains", "LA ULTIMA PALABRA")],
        "ESPN MX": [("contains", "FUTBOL PICANTE")],
        "LAS VOCES DEL FÚTBOL": [("contains", "JULIO RIOS")],
    }


def test_validate_channel_config_rejects_invalid_important_modes_and_rules(tmp_path):
    path = tmp_path / "channels.yaml"
    path.write_text(
        """
countries:
  - code: es
    name: España
    channels:
      - url: https://www.youtube.com/@badmode
        label: Bad mode
        important_mode: whole_channel
      - url: https://www.youtube.com/@missingrules
        label: Missing rules
        important_mode: program_rules
      - url: https://www.youtube.com/@badop
        label: Bad op
        important_mode: program_rules
        important_rules:
          - op: regex
            value: FUTBOL PICANTE
      - url: https://www.youtube.com/@empty
        label: Empty value
        important_mode: program_rules
        important_rules:
          - op: contains
            value: ""
      - url: https://www.youtube.com/@ranked
        label: Ranked normal
        algorithm_priority_rank: 7
""".strip(),
        encoding="utf-8",
    )

    report = validate_channel_config(load_channel_config(path))

    assert report.status == "failed"
    assert {finding.code for finding in report.findings} == {
        "invalid_important_mode",
        "important_program_rules_required",
        "invalid_important_rule_op",
        "important_rule_value_required",
    }


def test_default_editable_channel_config_contains_lequipe_seed():
    config = load_channel_config(SERVICE_ROOT / "config" / "channels.yaml")

    assert config.countries[0].code == "fr"
    assert config.countries[0].channels[0].url == "https://www.youtube.com/@lequipe"


def test_validate_channel_config_reports_missing_source_and_duplicate_channels(tmp_path):
    path = tmp_path / "channels.yaml"
    path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@lequipe
        label: L'Équipe FR
      - url: https://www.youtube.com/@lequipe
        label: Duplicate L'Équipe
      - label: Missing source
""".strip(),
        encoding="utf-8",
    )

    config = load_channel_config(path)
    report = validate_channel_config(config)

    assert report.status == "failed"
    assert {finding.code for finding in report.findings} == {"duplicate_channel_source", "missing_channel_source"}
    assert any("https://www.youtube.com/@lequipe" in finding.message for finding in report.findings)
    assert any("Missing source" in finding.message for finding in report.findings)


def test_validate_channel_config_accepts_unique_channel_ids_and_urls(tmp_path):
    path = tmp_path / "channels.yaml"
    path.write_text(
        """
countries:
  - code: fr
    name: France
    channels:
      - url: https://www.youtube.com/@lequipe
        label: L'Équipe
      - channel_id: UCTestStableChannelId
        label: Stable channel
""".strip(),
        encoding="utf-8",
    )

    report = validate_channel_config(load_channel_config(path))

    assert report.status == "ready"
    assert report.findings == []


def test_validate_channel_config_rejects_priority_tier_without_important_flag(tmp_path):
    path = tmp_path / "channels.yaml"
    path.write_text(
        """
countries:
  - code: ar
    name: Argentina
    channels:
      - url: https://www.youtube.com/@normal
        label: Normal channel
        priority_tier: importantes
""".strip(),
        encoding="utf-8",
    )

    report = validate_channel_config(load_channel_config(path))

    assert report.status == "failed"
    assert [(finding.code, finding.label) for finding in report.findings] == [
        ("priority_tier_requires_important", "Normal channel")
    ]
