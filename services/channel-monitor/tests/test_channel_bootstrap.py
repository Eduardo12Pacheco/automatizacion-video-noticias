from __future__ import annotations

from unittest.mock import MagicMock

from app.channel_bootstrap import _metadata_for_channel, sync_configured_channels
from app.store import ChannelRecord, MonitorStore
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
    name: Valdoria
    channels:
      - url: https://www.youtube.com/@demosportsgo
        label: Demo Sports
        enabled: true
        important: true
        priority_tier: importantes
        algorithm_priority_rank: 1
        important_mode: program_rules
        important_rules:
          - op: contains
            value: Madrugol
            content_types: [completed]
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
                "https://www.youtube.com/@demosportsgo": ChannelMetadata(
                    channel_id="UCDemoSportsStable",
                    title="Demo Sports",
                    uploads_playlist_id="UUDemoSportsStable",
                )
            }
        ),
    )

    channels = store.list_channels()
    assert report.status == "ready"
    assert report.synced_count == 1
    assert len(channels) == 1
    assert channels[0].youtube_channel_id == "UCDemoSportsStable"
    assert channels[0].important is True
    assert channels[0].important_mode == "program_rules"
    assert [(rule.op, rule.value, rule.content_types) for rule in channels[0].important_rules] == [("contains", "Madrugol", ["completed"])]
    assert channels[0].priority_tier == "importantes"
    assert channels[0].algorithm_priority_rank == 1


def test_sync_configured_channels_preserves_existing_channel_identity_while_updating_importance(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: ar
    name: Valdoria
    channels:
      - channel_id: UCExisting
        label: Existing Label
        enabled: true
        important: true
        important_mode: full_channel
        priority_tier: important
        algorithm_priority_rank: 2
""".strip(),
        encoding="utf-8",
    )
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(
        ChannelRecord(
            country="ar",
            label="Old Label",
            source_url=None,
            youtube_channel_id="UCExisting",
            uploads_playlist_id="UUExisting",
        )
    )

    report = sync_configured_channels(
        channels_path=channels_path,
        store=store,
        resolver=FakeResolver({}),
    )

    channel = store.find_channel_by_youtube_id("UCExisting")
    assert report.status == "ready"
    assert channel.uploads_playlist_id == "UUExisting"
    assert channel.important is True
    assert channel.important_mode == "full_channel"
    assert channel.priority_tier == "important"
    assert channel.algorithm_priority_rank == 2


# ---------------------------------------------------------------------------
# Regression tests for the _metadata_for_channel bypass fix.
#
# Channel bootstrap used to return uploads_playlist_id=None for brand-new
# channels added with the `channel_id` (resolver-bypass) field. The YouTube
# convention is that the uploads playlist id is "UU" + channel_id[2:]. These
# tests pin that derivation in place so a future refactor cannot regress it
# and silently re-break the catchup worker (which skips channels whose
# uploads_playlist_id is NULL/empty).
# ---------------------------------------------------------------------------


def _fake_store(existing: ChannelRecord | None) -> MonitorStore:
    store = MagicMock(spec=MonitorStore)
    store.find_channel_by_youtube_id.return_value = existing
    return store


def test_metadata_for_channel_derives_uploads_playlist_id_for_new_channel():
    channel_id = "UC4Ck2X1L_hhoeK1tojW8PXA"
    store = _fake_store(existing=None)
    resolver = MagicMock()

    metadata = _metadata_for_channel(channel_id=channel_id, url=None, store=store, resolver=resolver)

    assert metadata.channel_id == channel_id
    assert metadata.uploads_playlist_id == "UU4Ck2X1L_hhoeK1tojW8PXA"
    # The resolver must not be touched when channel_id is provided.
    resolver.resolve_channel.assert_not_called()


def test_metadata_for_channel_preserves_existing_uploads_playlist_id():
    channel_id = "UCjXIw1GlwaY1IzpW_jN9iCQ"
    existing = ChannelRecord(
        country="gb",
        label="The Overlap",
        source_url=None,
        youtube_channel_id=channel_id,
        uploads_playlist_id="UUcustom-override",
    )
    store = _fake_store(existing=existing)

    metadata = _metadata_for_channel(channel_id=channel_id, url=None, store=store, resolver=MagicMock())

    # Pre-existing non-empty uploads_playlist_id wins over the derived one.
    assert metadata.uploads_playlist_id == "UUcustom-override"
    assert metadata.title == "The Overlap"


def test_metadata_for_channel_falls_back_to_derived_playlist_id_when_existing_is_null():
    channel_id = "UCv-Nx8pSfG_LxbViMz14RWQ"
    existing = ChannelRecord(
        country="br",
        label="Jovem Pan Esportes",
        source_url=None,
        youtube_channel_id=channel_id,
        uploads_playlist_id=None,
    )
    store = _fake_store(existing=existing)

    metadata = _metadata_for_channel(channel_id=channel_id, url=None, store=store, resolver=MagicMock())

    # Defensive: even if a broken record already exists, derive instead of
    # returning None (which would skip the catchup worker for this channel).
    assert metadata.uploads_playlist_id == "UUv-Nx8pSfG_LxbViMz14RWQ"


def test_metadata_for_channel_falls_back_to_derived_playlist_id_when_existing_is_empty_string():
    channel_id = "UC3wwixCSDlZPR7vUYfringQ"
    existing = ChannelRecord(
        country="pk",
        label="SPORTS ADDICT",
        source_url=None,
        youtube_channel_id=channel_id,
        uploads_playlist_id="",
    )
    store = _fake_store(existing=existing)

    metadata = _metadata_for_channel(channel_id=channel_id, url=None, store=store, resolver=MagicMock())

    assert metadata.uploads_playlist_id == "UU3wwixCSDlZPR7vUYfringQ"


def test_metadata_for_channel_delegates_to_resolver_when_only_url_is_provided():
    url = "https://www.youtube.com/@LEquipe"
    resolved = ChannelMetadata(
        channel_id="UCyIV8rkza5Uk_sJIhqilBvQ",
        title="Demo Sports FR",
        uploads_playlist_id="UUyIV8rkza5Uk_sJIhqilBvQ",
    )
    store = _fake_store(existing=None)
    resolver = FakeResolver({url: resolved})

    metadata = _metadata_for_channel(channel_id=None, url=url, store=store, resolver=resolver)

    assert metadata == resolved
    assert resolver.calls == [url]
    store.find_channel_by_youtube_id.assert_not_called()


def test_metadata_for_channel_raises_when_neither_channel_id_nor_url_is_provided():
    store = _fake_store(existing=None)
    resolver = MagicMock()

    try:
        _metadata_for_channel(channel_id=None, url=None, store=store, resolver=resolver)
    except ValueError as exc:
        assert "Channel source is missing" in str(exc)
    else:
        raise AssertionError("expected ValueError when both channel_id and url are missing")


# ---------------------------------------------------------------------------
# Regression tests for the sync_configured_channels baseline_stamping change.
#
# Brand-new channels must get a baseline_started_at of "now" so the catchup
# worker only ingests content published from this moment forward. Existing
# channels must keep their baseline (e.g. set by a previous radar reset).
# ---------------------------------------------------------------------------


def test_sync_configured_channels_stamps_baseline_for_new_channel_with_channel_id(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: us
    name: Estados Unidos
    channels:
      - channel_id: UC4Ck2X1L_hhoeK1tojW8PXA
        label: Soccer on Demo TV
        enabled: true
""".strip(),
        encoding="utf-8",
    )
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()

    report = sync_configured_channels(
        channels_path=channels_path,
        store=store,
        resolver=FakeResolver({}),
    )

    assert report.status == "ready"
    channel = store.find_channel_by_youtube_id("UC4Ck2X1L_hhoeK1tojW8PXA")
    assert channel is not None
    # Derived playlist_id (UU...) is set on the new channel.
    assert channel.uploads_playlist_id == "UU4Ck2X1L_hhoeK1tojW8PXA"
    # baseline_started_at is stamped to "now" for new channels.
    assert channel.baseline_started_at is not None
    assert channel.baseline_started_at.endswith("Z")


def test_sync_configured_channels_preserves_existing_baseline_for_existing_channel(tmp_path):
    channels_path = tmp_path / "channels.yaml"
    channels_path.write_text(
        """
countries:
  - code: ar
    name: Valdoria
    channels:
      - channel_id: UCExisting
        label: Existing Label
        enabled: true
""".strip(),
        encoding="utf-8",
    )
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    # Pre-existing record with a custom baseline that came from a prior reset.
    store.upsert_channel(
        ChannelRecord(
            country="ar",
            label="Old Label",
            source_url=None,
            youtube_channel_id="UCExisting",
            uploads_playlist_id="UUExisting",
            baseline_started_at="2025-01-01T00:00:00Z",
        )
    )

    report = sync_configured_channels(
        channels_path=channels_path,
        store=store,
        resolver=FakeResolver({}),
    )

    assert report.status == "ready"
    channel = store.find_channel_by_youtube_id("UCExisting")
    # The previously-stamped baseline is preserved; sync must not clobber it.
    assert channel.baseline_started_at == "2025-01-01T00:00:00Z"
