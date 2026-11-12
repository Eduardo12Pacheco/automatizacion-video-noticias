from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = SERVICE_ROOT / "runtime" / "monitor.sqlite3"
DEFAULT_CHANNELS_CONFIG = SERVICE_ROOT / "config" / "channels.yaml"
DEFAULT_CATALOG_CONFIG = SERVICE_ROOT / "config" / "catalog.yaml"
IMPORTANT_MODES = {"full_channel", "program_rules"}
IMPORTANT_RULE_OPS = {"starts_with", "contains"}
NETWORK_MODE_LOCAL_DEV = "local_dev"
NETWORK_MODE_PROTECTED = "protected"
NETWORK_MODES = {NETWORK_MODE_LOCAL_DEV, NETWORK_MODE_PROTECTED}
FORBIDDEN_COOKIE_OR_BYPASS_ENVS = (
    "CHANNEL_MONITOR_YOUTUBE_COOKIES_PATH",
    "CHANNEL_MONITOR_BROWSER_COOKIES_PATH",
    "CHANNEL_MONITOR_BYPASS_COOKIES_PATH",
    "CHANNEL_MONITOR_BOTCHECK_BYPASS_TOKEN",
    "CHANNEL_MONITOR_CAPTCHA_API_KEY",
    "TRANSCRIPT_SERVICE_YT_DLP_COOKIES_PATH",
    "YOUTUBE_COOKIES_PATH",
)


@dataclass(frozen=True)
class Settings:
    api_key: str = ""
    db_path: Path = DEFAULT_DB_PATH
    channels_config_path: Path = DEFAULT_CHANNELS_CONFIG
    catalog_config_path: Path = DEFAULT_CATALOG_CONFIG
    radar_url: str = "http://127.0.0.1:8765"
    radar_api_key: str = ""
    callback_url: str = ""
    callback_secret: str = ""
    network_mode: str = NETWORK_MODE_LOCAL_DEV
    network_boundary_url: str = ""
    network_boundary_token: str = ""
    boundary_event_api_key: str = ""
    forbidden_cookie_or_bypass_envs: list[str] = field(default_factory=list)
    worker_enqueue_enabled: bool = True
    worker_enqueue_interval_seconds: int = 60
    worker_pending_live_enabled: bool = True
    worker_pending_live_interval_seconds: int = 300
    worker_cleanup_enabled: bool = True
    worker_cleanup_interval_seconds: int = 3600
    worker_websub_enabled: bool = False
    worker_websub_interval_seconds: int = 86400
    worker_catchup_enabled: bool = True
    worker_catchup_interval_seconds: int = 3600
    worker_catchup_initial_delay_seconds: int = 300
    worker_transcript_sync_enabled: bool = True
    worker_transcript_sync_interval_seconds: int = 60
    catchup_page_limit: int = 20
    catchup_item_limit: int = 1000
    backend_card_default_limit: int = 200
    backend_card_max_limit: int = 1000
    cleanup_retention_hours: int = 120
    cleanup_mode: str = "dry-run"
    websub_lease_seconds: int = 864000
    classification_version: str = "title-country-v1"


@dataclass(frozen=True)
class ImportantRule:
    content_types: list[str] = field(default_factory=list)
    op: str = ""
    value: str = ""


@dataclass(frozen=True)
class ChannelEntry:
    label: str
    url: str | None = None
    channel_id: str | None = None
    enabled: bool = True
    important: bool = False
    important_mode: str | None = None
    important_rules: list[ImportantRule] = field(default_factory=list)
    priority_tier: str | None = None
    algorithm_priority_rank: int | None = None

    @property
    def source_key(self) -> str:
        return (self.channel_id or self.url or "").strip().casefold()


@dataclass(frozen=True)
class CountryChannels:
    code: str
    name: str
    channels: list[ChannelEntry] = field(default_factory=list)


@dataclass(frozen=True)
class ChannelConfig:
    countries: list[CountryChannels] = field(default_factory=list)


@dataclass(frozen=True)
class ConfigFinding:
    code: str
    message: str
    country: str | None = None
    label: str | None = None


@dataclass(frozen=True)
class ConfigValidationReport:
    status: str
    findings: list[ConfigFinding]


@dataclass(frozen=True)
class NetworkBoundaryPolicyReport:
    status: str
    workers_enabled: bool
    findings: list[ConfigFinding]


def load_settings() -> Settings:
    return Settings(
        api_key=os.environ.get("CHANNEL_MONITOR_API_KEY", ""),
        db_path=Path(os.environ.get("CHANNEL_MONITOR_DB_PATH", DEFAULT_DB_PATH)),
        channels_config_path=Path(os.environ.get("CHANNEL_MONITOR_CHANNELS_CONFIG", DEFAULT_CHANNELS_CONFIG)),
        catalog_config_path=Path(os.environ.get("CHANNEL_MONITOR_CATALOG_CONFIG", DEFAULT_CATALOG_CONFIG)),
        radar_url=os.environ.get("CHANNEL_MONITOR_RADAR_URL", "http://127.0.0.1:8765"),
        radar_api_key=os.environ.get("CHANNEL_MONITOR_RADAR_API_KEY", ""),
        callback_url=os.environ.get("CHANNEL_MONITOR_CALLBACK_URL", ""),
        callback_secret=os.environ.get("CHANNEL_MONITOR_CALLBACK_SECRET", ""),
        network_mode=_network_mode(os.environ.get("CHANNEL_MONITOR_NETWORK_MODE", NETWORK_MODE_LOCAL_DEV)),
        network_boundary_url=os.environ.get("CHANNEL_MONITOR_NETWORK_BOUNDARY_URL", "").strip().rstrip("/"),
        network_boundary_token=os.environ.get("CHANNEL_MONITOR_NETWORK_BOUNDARY_TOKEN", ""),
        boundary_event_api_key=os.environ.get("CHANNEL_MONITOR_BOUNDARY_EVENT_API_KEY", ""),
        forbidden_cookie_or_bypass_envs=_present_forbidden_cookie_or_bypass_envs(),
        worker_enqueue_enabled=_env_bool("CHANNEL_MONITOR_WORKER_ENQUEUE_ENABLED", True),
        worker_enqueue_interval_seconds=_env_int("CHANNEL_MONITOR_WORKER_ENQUEUE_INTERVAL_SECONDS", 60),
        worker_pending_live_enabled=_env_bool("CHANNEL_MONITOR_WORKER_PENDING_LIVE_ENABLED", True),
        worker_pending_live_interval_seconds=_env_int("CHANNEL_MONITOR_WORKER_PENDING_LIVE_INTERVAL_SECONDS", 300),
        worker_cleanup_enabled=_env_bool("CHANNEL_MONITOR_WORKER_CLEANUP_ENABLED", True),
        worker_cleanup_interval_seconds=_env_int("CHANNEL_MONITOR_WORKER_CLEANUP_INTERVAL_SECONDS", 3600),
        worker_websub_enabled=_env_bool("CHANNEL_MONITOR_WORKER_WEBSUB_ENABLED", False),
        worker_websub_interval_seconds=_env_int("CHANNEL_MONITOR_WORKER_WEBSUB_INTERVAL_SECONDS", 86400),
        worker_catchup_enabled=_env_bool("CHANNEL_MONITOR_WORKER_CATCHUP_ENABLED", True),
        worker_catchup_interval_seconds=_env_int("CHANNEL_MONITOR_WORKER_CATCHUP_INTERVAL_SECONDS", 3600),
        worker_catchup_initial_delay_seconds=_env_int("CHANNEL_MONITOR_WORKER_CATCHUP_INITIAL_DELAY_SECONDS", 300),
        worker_transcript_sync_enabled=_env_bool("CHANNEL_MONITOR_WORKER_TRANSCRIPT_SYNC_ENABLED", True),
        worker_transcript_sync_interval_seconds=_env_int("CHANNEL_MONITOR_WORKER_TRANSCRIPT_SYNC_INTERVAL_SECONDS", 60),
        catchup_page_limit=_env_int("CHANNEL_MONITOR_CATCHUP_PAGE_LIMIT", 20),
        catchup_item_limit=_env_int("CHANNEL_MONITOR_CATCHUP_ITEM_LIMIT", 1000),
        backend_card_default_limit=_env_int("CHANNEL_MONITOR_BACKEND_CARD_DEFAULT_LIMIT", 200),
        backend_card_max_limit=_env_int("CHANNEL_MONITOR_BACKEND_CARD_MAX_LIMIT", 1000),
        cleanup_retention_hours=_env_int("CHANNEL_MONITOR_CLEANUP_RETENTION_HOURS", 120),
        cleanup_mode=os.environ.get("CHANNEL_MONITOR_CLEANUP_MODE", "dry-run"),
        websub_lease_seconds=_env_int("CHANNEL_MONITOR_WEBSUB_LEASE_SECONDS", 864000),
        classification_version=os.environ.get("CHANNEL_MONITOR_CLASSIFICATION_VERSION", "title-country-v1"),
    )


def load_channel_config(path: Path | str) -> ChannelConfig:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    countries = []
    for country in raw.get("countries", []):
        channels = [
            ChannelEntry(
                label=str(channel.get("label") or channel.get("url") or channel.get("channel_id") or "").strip(),
                url=_optional_str(channel.get("url")),
                channel_id=_optional_str(channel.get("channel_id")),
                enabled=bool(channel.get("enabled", True)),
                important=bool(channel.get("important", False)),
                important_mode=_optional_str(channel.get("important_mode")),
                important_rules=[_important_rule_from_dict(rule) for rule in channel.get("important_rules", [])],
                priority_tier=_optional_str(channel.get("priority_tier")),
                algorithm_priority_rank=_optional_int(channel.get("algorithm_priority_rank")),
            )
            for channel in country.get("channels", [])
        ]
        countries.append(
            CountryChannels(
                code=str(country.get("code", "")).strip().casefold(),
                name=str(country.get("name", "")).strip(),
                channels=channels,
            )
        )
    return ChannelConfig(countries=countries)


def validate_channel_config(config: ChannelConfig) -> ConfigValidationReport:
    findings: list[ConfigFinding] = []
    seen: dict[str, ChannelEntry] = {}
    for country in config.countries:
        for channel in country.channels:
            source_key = channel.source_key
            if not source_key:
                findings.append(
                    ConfigFinding(
                        code="missing_channel_source",
                        message=f"Channel '{channel.label}' in {country.code or 'unknown'} must define url or channel_id",
                        country=country.code,
                        label=channel.label,
                    )
                )
                continue
            if source_key in seen:
                findings.append(
                    ConfigFinding(
                        code="duplicate_channel_source",
                        message=f"Duplicate channel source '{channel.channel_id or channel.url}'",
                        country=country.code,
                        label=channel.label,
                    )
                )
                continue
            seen[source_key] = channel
            if channel.priority_tier and not channel.important:
                findings.append(
                    ConfigFinding(
                        code="priority_tier_requires_important",
                        message=f"Channel '{channel.label}' defines priority_tier without important: true",
                        country=country.code,
                        label=channel.label,
                    )
                )
            if channel.important_mode and channel.important_mode not in IMPORTANT_MODES:
                findings.append(
                    ConfigFinding(
                        code="invalid_important_mode",
                        message=f"Channel '{channel.label}' has invalid important_mode '{channel.important_mode}'",
                        country=country.code,
                        label=channel.label,
                    )
                )
            if channel.important_mode == "program_rules" and not channel.important_rules:
                findings.append(
                    ConfigFinding(
                        code="important_program_rules_required",
                        message=f"Channel '{channel.label}' must define important_rules when important_mode is program_rules",
                        country=country.code,
                        label=channel.label,
                    )
                )
            for rule in channel.important_rules:
                if rule.op not in IMPORTANT_RULE_OPS:
                    findings.append(
                        ConfigFinding(
                            code="invalid_important_rule_op",
                            message=f"Channel '{channel.label}' has invalid important rule op '{rule.op}'",
                            country=country.code,
                            label=channel.label,
                        )
                    )
                if not rule.value.strip():
                    findings.append(
                        ConfigFinding(
                            code="important_rule_value_required",
                            message=f"Channel '{channel.label}' has an important rule without a value",
                            country=country.code,
                            label=channel.label,
                        )
                    )
    return ConfigValidationReport(status="failed" if findings else "ready", findings=findings)


def load_and_validate_channel_config(path: Path | str) -> ConfigValidationReport:
    config_path = Path(path)
    if not config_path.exists():
        return ConfigValidationReport(
            status="failed",
            findings=[ConfigFinding(code="missing_channels_config", message=f"Channel config not found: {config_path}")],
        )
    return validate_channel_config(load_channel_config(config_path))


def validation_report_to_dict(report: ConfigValidationReport) -> dict[str, Any]:
    return {
        "status": report.status,
        "findings": [
            {"code": finding.code, "message": finding.message, "country": finding.country, "label": finding.label}
            for finding in report.findings
        ],
    }


def validate_network_boundary_policy(settings: Settings) -> NetworkBoundaryPolicyReport:
    findings: list[ConfigFinding] = []
    network_mode = _network_mode(settings.network_mode)

    if network_mode not in NETWORK_MODES:
        findings.append(
            ConfigFinding(
                code="invalid_network_mode",
                message="CHANNEL_MONITOR_NETWORK_MODE must be 'protected' or 'local_dev'",
            )
        )

    if network_mode == NETWORK_MODE_PROTECTED:
        if not settings.network_boundary_url.strip():
            findings.append(
                ConfigFinding(
                    code="boundary_url_required",
                    message="CHANNEL_MONITOR_NETWORK_BOUNDARY_URL is required in protected mode",
                )
            )
        if not settings.network_boundary_token.strip():
            findings.append(
                ConfigFinding(
                    code="boundary_token_required",
                    message="CHANNEL_MONITOR_NETWORK_BOUNDARY_TOKEN is required in protected mode",
                )
            )
        if settings.forbidden_cookie_or_bypass_envs:
            findings.append(
                ConfigFinding(
                    code="cookie_config_forbidden",
                    message="Channel cookies, browser-session credentials, CAPTCHA, and botcheck bypass configuration are forbidden in protected mode",
                )
            )

    status = "failed" if findings else "ready"
    return NetworkBoundaryPolicyReport(
        status=status,
        workers_enabled=status == "ready",
        findings=findings,
    )


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return int(text)


def _network_mode(value: Any) -> str:
    return str(value or NETWORK_MODE_LOCAL_DEV).strip().casefold() or NETWORK_MODE_LOCAL_DEV


def _present_forbidden_cookie_or_bypass_envs() -> list[str]:
    return [name for name in FORBIDDEN_COOKIE_OR_BYPASS_ENVS if os.environ.get(name, "").strip()]


def _important_rule_from_dict(raw: Any) -> ImportantRule:
    rule = raw if isinstance(raw, dict) else {}
    raw_content_types = rule.get("content_types", [])
    content_types = raw_content_types if isinstance(raw_content_types, list) else [raw_content_types]
    return ImportantRule(
        content_types=[str(content_type).strip() for content_type in content_types if str(content_type).strip()],
        op=str(rule.get("op", "")).strip(),
        value=str(rule.get("value", "")).strip(),
    )


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().casefold() in {"1", "true", "yes", "on"}


def _env_csv(name: str, *, fallback: str = "") -> list[str]:
    raw = os.environ.get(name, "")
    values = [item.strip() for item in raw.split(",") if item.strip()]
    if values:
        return values
    fallback = fallback.strip()
    return [fallback] if fallback else []


def _env_optional_path(name: str, *, fallback: str = "") -> Path | None:
    raw = os.environ.get(name, fallback).strip()
    return Path(raw) if raw else None


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return int(raw)
