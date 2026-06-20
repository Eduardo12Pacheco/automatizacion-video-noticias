from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from .settings import ConfigFinding, load_channel_config, validate_channel_config
from .store import ChannelRecord, MonitorStore
from .youtube_client import ChannelMetadata


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class ChannelResolver(Protocol):
    def resolve_channel(self, source: str) -> ChannelMetadata: ...


@dataclass(frozen=True)
class ChannelSyncReport:
    status: str
    synced_count: int = 0
    findings: list[ConfigFinding] = field(default_factory=list)


def sync_configured_channels(
    *,
    channels_path: Path | str,
    store: MonitorStore,
    resolver: ChannelResolver,
) -> ChannelSyncReport:
    config = load_channel_config(channels_path)
    validation = validate_channel_config(config)
    if validation.findings:
        return ChannelSyncReport(status="failed", findings=validation.findings)

    synced_count = 0
    findings: list[ConfigFinding] = []
    seen_channel_ids: set[str] = set()
    for country in config.countries:
        for channel in country.channels:
            try:
                metadata = _metadata_for_channel(channel.channel_id, channel.url, store, resolver)
            except Exception as exc:
                findings.append(
                    ConfigFinding(
                        code="channel_resolution_failed",
                        message=f"Could not resolve channel '{channel.label}': {exc}",
                        country=country.code,
                        label=channel.label,
                    )
                )
                continue
            stable_id = metadata.channel_id.strip()
            stable_key = stable_id.casefold()
            if stable_key in seen_channel_ids:
                findings.append(
                    ConfigFinding(
                        code="duplicate_stable_channel_id",
                        message=f"Duplicate resolved YouTube channel ID '{stable_id}'",
                        country=country.code,
                        label=channel.label,
                    )
                )
                continue
            seen_channel_ids.add(stable_key)
            existing = store.find_channel_by_youtube_id(stable_id)
            # Stamp baseline_started_at only for brand-new channels so the catchup
            # worker only sees content published from this moment forward. For
            # existing channels, pass None and let upsert_channel coalesce to
            # preserve any baseline already set (e.g. by a radar reset).
            baseline_started_at = _utc_now_iso() if existing is None else None
            store.upsert_channel(
                ChannelRecord(
                    country=country.code,
                    label=channel.label or metadata.title,
                    source_url=channel.url,
                    youtube_channel_id=stable_id,
                    uploads_playlist_id=metadata.uploads_playlist_id,
                    enabled=channel.enabled,
                    important=channel.important,
                    important_mode=channel.important_mode,
                    important_rules=channel.important_rules,
                    priority_tier=channel.priority_tier,
                    algorithm_priority_rank=channel.algorithm_priority_rank,
                    baseline_started_at=baseline_started_at,
                )
            )
            synced_count += 1

    return ChannelSyncReport(status="failed" if findings else "ready", synced_count=synced_count, findings=findings)


def channel_sync_report_to_dict(report: ChannelSyncReport) -> dict[str, object]:
    return {
        "status": report.status,
        "synced_count": report.synced_count,
        "findings": [
            {"code": finding.code, "message": finding.message, "country": finding.country, "label": finding.label}
            for finding in report.findings
        ],
    }


def _metadata_for_channel(channel_id: str | None, url: str | None, store: MonitorStore, resolver: ChannelResolver) -> ChannelMetadata:
    if channel_id:
        existing = store.find_channel_by_youtube_id(channel_id)
        derived_playlist_id = f"UU{channel_id[2:]}"  # YouTube convention: UC -> UU
        return ChannelMetadata(
            channel_id=channel_id,
            title=existing.label if existing else channel_id,
            uploads_playlist_id=(
                existing.uploads_playlist_id
                if existing and existing.uploads_playlist_id
                else derived_playlist_id
            ),
        )
    if not url:
        raise ValueError("Channel source is missing")
    return resolver.resolve_channel(url)
