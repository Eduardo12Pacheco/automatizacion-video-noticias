from __future__ import annotations

import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from .youtube_client import ChannelMetadata, MetadataUnavailable, UploadItem, VideoMetadata

RSS_FEED_URL = "https://www.youtube.com/feeds/videos.xml"
YOUTUBE_BASE_URL = "https://www.youtube.com"
ATOM = "{http://www.w3.org/2005/Atom}"
YT = "{http://www.youtube.com/xml/schemas/2015}"
MEDIA = "{http://search.yahoo.com/mrss/}"
CHANNEL_ID_RE = re.compile(r"UC[A-Za-z0-9_-]{10,}")


class HttpResponse(Protocol):
    status_code: int
    text: str


class HttpClient(Protocol):
    def get(self, url: str, params: dict[str, Any] | None = None) -> HttpResponse: ...


@dataclass(frozen=True)
class RssEntry:
    video_id: str
    channel_id: str
    title: str
    published_at: str | None


class _UrllibHttpClient:
    def get(self, url: str, params: dict[str, Any] | None = None) -> Any:
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(url, headers={"user-agent": "newsroom-channel-monitor/0.1"})
        with urllib.request.urlopen(request, timeout=20) as response:
            return _UrllibResponse(response.status, response.read().decode("utf-8", errors="replace"))


@dataclass(frozen=True)
class _UrllibResponse:
    status_code: int
    text: str


def playlist_to_channel_id(value: str) -> str:
    playlist_id = str(value or "").strip()
    if playlist_id.startswith("UU") and len(playlist_id) > 2:
        return f"UC{playlist_id[2:]}"
    if playlist_id.startswith("UC") and len(playlist_id) > 2:
        return playlist_id
    raise MetadataUnavailable(playlist_id, f"Unsupported uploads playlist id: {playlist_id}")


def channel_to_uploads_playlist_id(channel_id: str) -> str:
    channel = str(channel_id or "").strip()
    if channel.startswith("UC"):
        return f"UU{channel[2:]}"
    return f"UU{channel}"


def parse_rss_feed(xml_text: str) -> tuple[str, list[RssEntry]]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise MetadataUnavailable("rss", f"Invalid YouTube RSS feed: {exc}") from exc
    feed_title = (root.findtext(f"{ATOM}title") or "").strip()
    entries: list[RssEntry] = []
    for entry in root.findall(f"{ATOM}entry"):
        video_id = (entry.findtext(f"{YT}videoId") or "").strip()
        if not video_id:
            raw_id = (entry.findtext(f"{ATOM}id") or "").strip()
            video_id = raw_id.rsplit(":", 1)[-1] if raw_id else ""
        if not video_id:
            continue
        title = (entry.findtext(f"{ATOM}title") or entry.findtext(f"{MEDIA}group/{MEDIA}title") or "").strip()
        channel_id = (entry.findtext(f"{YT}channelId") or "").strip()
        published = (entry.findtext(f"{ATOM}published") or "").strip() or None
        entries.append(RssEntry(video_id=video_id, channel_id=channel_id, title=title, published_at=published))
    return feed_title, entries


class RssChannelClient:
    """YouTube channel feed client that needs no API key.

    It replaces the YouTube Data API client for local/dev mode: channel
    resolution reads the public channel page, uploads come from the public RSS
    feed (`feeds/videos.xml?channel_id=...`) and video metadata is matching
    feed entries.
    """

    def __init__(
        self,
        *,
        http: HttpClient | None = None,
        channel_ids_provider: Callable[[], list[str]] | None = None,
        cache_ttl_seconds: float = 60.0,
        clock: Callable[[], float] | None = None,
    ):
        self.http = http or _UrllibHttpClient()
        self.channel_ids_provider = channel_ids_provider or (lambda: [])
        self.cache_ttl_seconds = max(0.0, float(cache_ttl_seconds))
        self.clock = clock or time.monotonic
        self._feed_cache: dict[str, tuple[float, str, list[RssEntry]]] = {}
        self._video_index: dict[str, VideoMetadata] = {}

    def resolve_channel(self, source: str) -> ChannelMetadata:
        channel_id = self._extract_channel_id(source)
        if channel_id is None:
            channel_id = self._resolve_channel_id_from_page(source)
        feed_title, _entries = self._load_feed(channel_id)
        return ChannelMetadata(
            channel_id=channel_id,
            title=feed_title or channel_id,
            uploads_playlist_id=channel_to_uploads_playlist_id(channel_id),
        )

    def get_video_metadata(self, video_id: str) -> VideoMetadata:
        cached = self._video_index.get(video_id)
        if cached is not None:
            return cached
        for channel_id in self._known_channel_ids():
            _title, entries = self._load_feed(channel_id)
            self._index_entries(entries)
            if video_id in self._video_index:
                return self._video_index[video_id]
        raise MetadataUnavailable(video_id)

    def list_upload_video_ids(self, uploads_playlist_id: str, *, limit: int) -> list[str]:
        channel_id = playlist_to_channel_id(uploads_playlist_id)
        _title, entries = self._load_feed(channel_id)
        return [entry.video_id for entry in entries[: max(1, int(limit))]]

    def iter_upload_items(self, uploads_playlist_id: str, *, page_limit: int = 20, item_limit: int = 1000):
        channel_id = playlist_to_channel_id(uploads_playlist_id)
        _title, entries = self._load_feed(channel_id)
        for entry in entries[: max(1, int(item_limit))]:
            yield UploadItem(video_id=entry.video_id, published_at=entry.published_at, page_token=None)

    def _known_channel_ids(self) -> list[str]:
        ids: list[str] = []
        try:
            candidates = list(self.channel_ids_provider() or [])
        except Exception:
            candidates = []
        for value in [*candidates, *self._feed_cache.keys()]:
            channel_id = str(value or "").strip()
            if channel_id and channel_id not in ids:
                ids.append(channel_id)
        return ids

    def _load_feed(self, channel_id: str) -> tuple[str, list[RssEntry]]:
        now = self.clock()
        cached = self._feed_cache.get(channel_id)
        if cached and now - cached[0] < self.cache_ttl_seconds:
            return cached[1], cached[2]
        response = self.http.get(RSS_FEED_URL, {"channel_id": channel_id})
        if int(getattr(response, "status_code", 200)) >= 400:
            raise MetadataUnavailable(channel_id, f"YouTube RSS feed returned HTTP {response.status_code}")
        title, entries = parse_rss_feed(response.text)
        self._feed_cache[channel_id] = (now, title, entries)
        self._index_entries(entries)
        return title, entries

    def _index_entries(self, entries: list[RssEntry]) -> None:
        for entry in entries:
            self._video_index.setdefault(
                entry.video_id,
                VideoMetadata(
                    video_id=entry.video_id,
                    channel_id=entry.channel_id,
                    title=entry.title,
                    published_at=entry.published_at,
                    live_status="none",
                ),
            )

    @staticmethod
    def _extract_channel_id(source: str) -> str | None:
        text = str(source or "").strip()
        if not text:
            return None
        if text.startswith("UC") and "/" not in text:
            return text
        channel_match = re.search(r"/channel/(UC[A-Za-z0-9_-]+)", text)
        if channel_match:
            return channel_match.group(1)
        return None

    def _resolve_channel_id_from_page(self, source: str) -> str:
        text = str(source or "").strip()
        if not text:
            raise MetadataUnavailable(source, "Channel source is empty")
        if text.startswith(("http://", "https://")):
            url = text
        else:
            handle = text if text.startswith("@") else f"@{text.lstrip('/')}"
            url = f"{YOUTUBE_BASE_URL}/{handle}"
        response = self.http.get(url, None)
        if int(getattr(response, "status_code", 200)) >= 400:
            raise MetadataUnavailable(source, f"Channel page returned HTTP {response.status_code}")
        html = str(getattr(response, "text", "") or "")
        for pattern in (r'"channelId":"(UC[A-Za-z0-9_-]+)"', r'channel_id=(UC[A-Za-z0-9_-]+)'):
            match = re.search(pattern, html)
            if match and CHANNEL_ID_RE.fullmatch(match.group(1)):
                return match.group(1)
        raise MetadataUnavailable(source, f"Could not resolve channel id for {source}")
