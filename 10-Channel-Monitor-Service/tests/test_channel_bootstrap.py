from __future__ import annotations

from app.channel_bootstrap import sync_configured_channels
from app.store import MonitorStore
from app.youtube_client import ChannelMetadata


class FakeResolver:
    def __init__(self, resolved_by_source: dict[str, ChannelMetadata]):
        self.resolved_by_source = resolved_by_source
        self.calls: list[str] = []

    def resolve_channel(self, source: str) -> ChannelMetadata:
        self.calls.append(source)
        return self.resolved_by_source[source]


def test_sync_configured_channels_persists_important_metadata_without_duplicate_alias(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: ar
    name: Argentina
    channels:
      - url: https://www.youtube.com/@NSportsGo
        label: NSports
        enabled: true
        important: true
        priority_tier: importantes
        algorithm_priority_rank: 1
""".strip(),
        encoding="utf-8",
    )
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()

    report = sync_configured_channels(
        channels_path=channels_path,
        store=store,
        resolver=FakeResolver(
            {
                "https://www.youtube.com/@NSportsGo": ChannelMetadata(
                    channel_id="UCNSportsStable",
                    title="NSports",
                    uploads_playlist_id="UUNSportsStable",
                )
            }
        ),
    )

    channels = store.list_channels()
    assert report.status == "ready"
    assert report.synced_count == 1
    assert len(channels) == 1
    assert channels[0].youtube_channel_id == "UCNSportsStable"
    assert channels[0].important is True
    assert channels[0].priority_tier == "importantes"
    assert channels[0].algorithm_priority_rank == 1
