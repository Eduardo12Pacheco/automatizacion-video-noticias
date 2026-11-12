from __future__ import annotations

from pathlib import Path

import pytest

from app.rss_client import (
    RssChannelClient,
    channel_to_uploads_playlist_id,
    parse_rss_feed,
    playlist_to_channel_id,
)
from app.youtube_client import MetadataUnavailable

FEED_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
  <title>Demo Sports News</title>
  <entry>
    <id>yt:video:video-1</id>
    <yt:videoId>video-1</yt:videoId>
    <yt:channelId>UCdemoChannel123</yt:channelId>
    <title>Gol de demostración</title>
    <published>2026-01-01T10:00:00+00:00</published>
  </entry>
  <entry>
    <id>yt:video:video-2</id>
    <yt:videoId>video-2</yt:videoId>
    <yt:channelId>UCdemoChannel123</yt:channelId>
    <title>Segundo partido</title>
    <published>2026-01-02T10:00:00+00:00</published>
  </entry>
</feed>
"""


class _Response:
    def __init__(self, text: str, status_code: int = 200):
        self.text = text
        self.status_code = status_code


class _Http:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, url, params=None):
        self.calls.append((url, params))
        result = self.responses.get(url)
        if result is None and params:
            result = self.responses.get(f"{url}?channel_id={params['channel_id']}")
        if result is None:
            return _Response("not found", 404)
        return _Response(result) if isinstance(result, str) else result


def test_feed_parsing_reads_real_entry_metadata() -> None:
    title, entries = parse_rss_feed(FEED_XML)

    assert title == "Demo Sports News"
    assert [(entry.video_id, entry.channel_id, entry.title) for entry in entries] == [
        ("video-1", "UCdemoChannel123", "Gol de demostración"),
        ("video-2", "UCdemoChannel123", "Segundo partido"),
    ]
    assert entries[0].published_at == "2026-01-01T10:00:00+00:00"


def test_playlist_and_channel_ids_round_trip() -> None:
    assert playlist_to_channel_id("UUdemoChannel123") == "UCdemoChannel123"
    assert playlist_to_channel_id("UCdemoChannel123") == "UCdemoChannel123"
    assert channel_to_uploads_playlist_id("UCdemoChannel123") == "UUdemoChannel123"
    with pytest.raises(MetadataUnavailable):
        playlist_to_channel_id("PLnot-a-channel")


def test_resolve_channel_direct_id_uses_public_rss_feed() -> None:
    http = _Http({"https://www.youtube.com/feeds/videos.xml?channel_id=UCdemoChannel123": FEED_XML})
    client = RssChannelClient(http=http)

    metadata = client.resolve_channel("UCdemoChannel123")

    assert metadata.channel_id == "UCdemoChannel123"
    assert metadata.title == "Demo Sports News"
    assert metadata.uploads_playlist_id == "UUdemoChannel123"


def test_resolve_channel_handle_reads_channel_id_from_page() -> None:
    page = '<script>"channelId":"UCdemoChannel123"</script>'
    http = _Http(
        {
            "https://www.youtube.com/@demo": page,
            "https://www.youtube.com/feeds/videos.xml?channel_id=UCdemoChannel123": FEED_XML,
        }
    )
    client = RssChannelClient(http=http)

    assert client.resolve_channel("@demo").channel_id == "UCdemoChannel123"
    assert client.resolve_channel("https://www.youtube.com/@demo").channel_id == "UCdemoChannel123"


def test_upload_listing_and_video_metadata_come_from_rss_without_api_key() -> None:
    http = _Http({"https://www.youtube.com/feeds/videos.xml?channel_id=UCdemoChannel123": FEED_XML})
    client = RssChannelClient(http=http, channel_ids_provider=lambda: ["UCdemoChannel123"])

    ids = client.list_upload_video_ids("UUdemoChannel123", limit=10)
    items = list(client.iter_upload_items("UUdemoChannel123", item_limit=1))
    metadata = client.get_video_metadata("video-2")

    assert ids == ["video-1", "video-2"]
    assert [(item.video_id, item.published_at) for item in items] == [
        ("video-1", "2026-01-01T10:00:00+00:00")
    ]
    assert (metadata.video_id, metadata.channel_id, metadata.title, metadata.live_status) == (
        "video-2",
        "UCdemoChannel123",
        "Segundo partido",
        "none",
    )
    assert all("key=" not in (params or {}).get("key", "") for _url, params in http.calls)


def test_unknown_video_reports_metadata_unavailable_and_feeds_are_cached() -> None:
    http = _Http({"https://www.youtube.com/feeds/videos.xml?channel_id=UCdemoChannel123": FEED_XML})
    client = RssChannelClient(http=http, channel_ids_provider=lambda: ["UCdemoChannel123"])

    with pytest.raises(MetadataUnavailable):
        client.get_video_metadata("missing")
    client.list_upload_video_ids("UUdemoChannel123", limit=1)
    client.list_upload_video_ids("UUdemoChannel123", limit=1)

    assert len(http.calls) == 1


def test_missing_feed_entries_raise_metadata_unavailable() -> None:
    http = _Http({"https://www.youtube.com/feeds/videos.xml?channel_id=UCbroken": _Response("nope", 500)})
    client = RssChannelClient(http=http)

    with pytest.raises(MetadataUnavailable):
        client.resolve_channel("UCbroken")
