from __future__ import annotations

import hashlib
import hmac
import json
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from .title_matcher import normalize_country, normalize_title


YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
WEBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/subscribe"
YOUTUBE_FEED_URL = "https://www.youtube.com/xml/feeds/videos.xml"


class HttpResponse(Protocol):
    status_code: int
    text: str

    def json(self) -> dict[str, Any]: ...


class HttpClient(Protocol):
    def get(self, url: str, params: dict[str, Any]) -> HttpResponse: ...

    def post(self, url: str, data: dict[str, Any], timeout: int) -> HttpResponse: ...


@dataclass(frozen=True)
class ChannelMetadata:
    channel_id: str
    title: str
    uploads_playlist_id: str | None = None


@dataclass(frozen=True)
class VideoMetadata:
    video_id: str
    channel_id: str
    title: str
    published_at: str | None
    live_status: str


@dataclass(frozen=True)
class UploadItem:
    video_id: str
    published_at: str | None
    page_token: str | None = None


@dataclass(frozen=True)
class SubtitleSegment:
    start_ms: int
    end_ms: int
    text: str
    language: str


@dataclass(frozen=True)
class CaptionLanguageResolution:
    language: str
    source_country: str | None
    fallback_used: bool
    reason: str


COUNTRY_LANGUAGE_CODES = {
    "argentina": "es",
    "mexico": "es",
    "colombia": "es",
    "ecuador": "es",
    "uruguay": "es",
    "paraguay": "es",
    "spain": "es",
    "espana": "es",
    "france": "fr",
    "england": "en",
    "united kingdom": "en",
    "uk": "en",
    "usa": "en",
    "united states": "en",
    "italy": "it",
    "brazil": "pt",
    "brasil": "pt",
}

DIRECT_LANGUAGE_CODES = {"es", "en", "fr", "it", "pt"}


class MetadataUnavailable(RuntimeError):
    def __init__(self, video_id: str, message: str | None = None):
        self.video_id = video_id
        super().__init__(message or f"Metadata unavailable for video {video_id}")


class SubtitleUnavailable(RuntimeError):
    def __init__(
        self,
        video_id: str,
        language: str,
        message: str | None = None,
        *,
        reason: str = "unavailable",
        details: dict[str, Any] | None = None,
    ):
        self.video_id = video_id
        self.language = language
        self.reason = reason
        self.details = details or {}
        super().__init__(message or f"Subtitles unavailable for video {video_id} in {language}: {reason}")


class CallbackValidationError(RuntimeError):
    pass


class YouTubeDataClient:
    def __init__(self, *, api_key: str, http: HttpClient | None = None):
        self.api_key = api_key
        self.http = http or _UrllibHttpClient()

    def resolve_channel(self, source: str) -> ChannelMetadata:
        params = {"part": "snippet,contentDetails", "key": self.api_key}
        channel_id = _extract_channel_id(source)
        if channel_id:
            params["id"] = channel_id
        else:
            params["forHandle"] = _extract_handle(source)
        payload = self.http.get(f"{YOUTUBE_API_BASE}/channels", params=params).json()
        items = payload.get("items") or []
        if not items:
            raise MetadataUnavailable(source, f"Channel metadata unavailable for {source}")
        item = items[0]
        return ChannelMetadata(
            channel_id=str(item.get("id", "")),
            title=str(item.get("snippet", {}).get("title", "")),
            uploads_playlist_id=item.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads"),
        )

    def get_video_metadata(self, video_id: str) -> VideoMetadata:
        payload = self.http.get(
            f"{YOUTUBE_API_BASE}/videos",
            params={"part": "snippet,liveStreamingDetails", "id": video_id, "key": self.api_key},
        ).json()
        items = payload.get("items") or []
        if not items:
            raise MetadataUnavailable(video_id)
        item = items[0]
        snippet = item.get("snippet", {})
        return VideoMetadata(
            video_id=str(item.get("id") or video_id),
            channel_id=str(snippet.get("channelId", "")),
            title=str(snippet.get("title", "")),
            published_at=snippet.get("publishedAt"),
            live_status=_live_status(item),
        )

    def list_upload_video_ids(self, uploads_playlist_id: str, *, limit: int) -> list[str]:
        payload = self.http.get(
            f"{YOUTUBE_API_BASE}/playlistItems",
            params={
                "part": "contentDetails",
                "playlistId": uploads_playlist_id,
                "maxResults": max(1, min(int(limit), 50)),
                "key": self.api_key,
            },
        ).json()
        video_ids: list[str] = []
        for item in payload.get("items") or []:
            video_id = str(item.get("contentDetails", {}).get("videoId") or "").strip()
            if video_id:
                video_ids.append(video_id)
        return video_ids

    def iter_upload_items(self, uploads_playlist_id: str, *, page_limit: int = 20, item_limit: int = 1000):
        next_page_token: str | None = None
        yielded = 0
        for _page in range(max(1, int(page_limit))):
            params: dict[str, Any] = {
                "part": "snippet,contentDetails",
                "playlistId": uploads_playlist_id,
                "maxResults": 50,
                "key": self.api_key,
            }
            if next_page_token:
                params["pageToken"] = next_page_token
            payload = self.http.get(f"{YOUTUBE_API_BASE}/playlistItems", params=params).json()
            current_page_token = next_page_token
            for item in payload.get("items") or []:
                details = item.get("contentDetails", {})
                snippet = item.get("snippet", {})
                video_id = str(details.get("videoId") or snippet.get("resourceId", {}).get("videoId") or "").strip()
                if not video_id:
                    continue
                yield UploadItem(video_id=video_id, published_at=details.get("videoPublishedAt") or snippet.get("publishedAt"), page_token=current_page_token)
                yielded += 1
                if yielded >= max(1, int(item_limit)):
                    return
            next_page_token = str(payload.get("nextPageToken") or "").strip() or None
            if not next_page_token:
                return


class SubtitleProvider(Protocol):
    def fetch(
        self, *, video_id: str, source_language: str | None, default_language: str
    ) -> list[SubtitleSegment]: ...


class TimedTextSubtitleProvider:
    def __init__(self, *, http: HttpClient | None = None, timed_text_url: str = "https://www.youtube.com/api/timedtext"):
        self.http = http or _UrllibHttpClient()
        self.timed_text_url = timed_text_url

    def fetch(self, *, video_id: str, source_language: str | None, default_language: str) -> list[SubtitleSegment]:
        resolution = resolve_caption_language(source_country=source_language, default_language=default_language)
        language = resolution.language
        response = self.http.get(self.timed_text_url, params={"v": video_id, "lang": language, "fmt": "srv3"})
        segments = _parse_timed_text(response.text, language=language)
        if not segments:
            raise SubtitleUnavailable(
                video_id,
                language,
                reason="empty_transcript",
                details={
                    "provider": "youtube-timedtext",
                    "reason": "empty_transcript",
                    "video_id": video_id,
                    "language": language,
                    "source_language": source_language,
                    "default_language": default_language,
                    "resolution_reason": resolution.reason,
                    "fallback_used": resolution.fallback_used,
                },
            )
        return segments


class TranscriptListAdapter(Protocol):
    def find_manually_created_transcript(self, languages: list[str]) -> Any: ...

    def find_generated_transcript(self, languages: list[str]) -> Any: ...


class TranscriptApiAdapter(Protocol):
    def list_transcripts(self, video_id: str) -> TranscriptListAdapter: ...


class YouTubeTranscriptApiAdapter:
    def __init__(self):
        from youtube_transcript_api import YouTubeTranscriptApi

        self.api = YouTubeTranscriptApi()

    def list_transcripts(self, video_id: str) -> TranscriptListAdapter:
        if hasattr(self.api, "list"):
            return self.api.list(video_id)
        return self.api.list_transcripts(video_id)


class YouTubeTranscriptSubtitleProvider:
    provider_name = "youtube-transcript-api"

    def __init__(
        self,
        *,
        api: TranscriptApiAdapter | None = None,
        api_factory: Callable[[], TranscriptApiAdapter] | None = None,
    ):
        self._api = api
        self._api_factory = api_factory or YouTubeTranscriptApiAdapter

    def fetch(self, *, video_id: str, source_language: str | None, default_language: str) -> list[SubtitleSegment]:
        resolution = resolve_caption_language(source_country=source_language, default_language=default_language)
        requested_languages = _unique_languages([resolution.language, _normalize_language_code(default_language), "en"])
        details = self._base_error_details(
            video_id=video_id,
            source_language=source_language,
            default_language=default_language,
            resolution=resolution,
            requested_languages=requested_languages,
        )
        try:
            transcript_list = self._adapter().list_transcripts(video_id)
            transcript = self._select_transcript(transcript_list, requested_languages=requested_languages)
            snippets = transcript.fetch()
        except ImportError as exc:
            raise self._unavailable(
                video_id=video_id,
                language=resolution.language,
                reason="dependency_missing",
                details=details,
                error=exc,
            ) from exc
        except Exception as exc:
            reason = _transcript_error_reason(exc)
            raise self._unavailable(
                video_id=video_id,
                language=resolution.language,
                reason=reason,
                details=details,
                error=exc,
            ) from exc
        actual_language = _transcript_language(transcript, fallback=resolution.language)
        segments = _parse_transcript_api_snippets(snippets, language=actual_language)
        if not segments:
            empty_details = {**details, "reason": "empty_transcript", "actual_language": actual_language}
            raise SubtitleUnavailable(
                video_id,
                actual_language,
                reason="empty_transcript",
                details=empty_details,
            )
        return segments

    def _adapter(self) -> TranscriptApiAdapter:
        if self._api is None:
            self._api = self._api_factory()
        return self._api

    def _select_transcript(self, transcript_list: TranscriptListAdapter, *, requested_languages: list[str]) -> Any:
        last_error: Exception | None = None
        for finder_name in ("find_manually_created_transcript", "find_generated_transcript"):
            finder = getattr(transcript_list, finder_name)
            try:
                return finder(requested_languages)
            except Exception as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise RuntimeError("No transcript finder available")

    def _base_error_details(
        self,
        *,
        video_id: str,
        source_language: str | None,
        default_language: str,
        resolution: CaptionLanguageResolution,
        requested_languages: list[str],
    ) -> dict[str, Any]:
        return {
            "provider": self.provider_name,
            "reason": "unavailable",
            "video_id": video_id,
            "requested_languages": requested_languages,
            "source_language": source_language,
            "default_language": default_language,
            "resolution_reason": resolution.reason,
            "fallback_used": resolution.fallback_used,
        }

    def _unavailable(
        self,
        *,
        video_id: str,
        language: str,
        reason: str,
        details: dict[str, Any],
        error: Exception,
    ) -> SubtitleUnavailable:
        error_details = {
            **details,
            "reason": reason,
            "error_type": type(error).__name__,
            "error": str(error),
        }
        return SubtitleUnavailable(video_id, language, reason=reason, details=error_details)


def resolve_caption_language(*, source_country: str | None, default_language: str) -> CaptionLanguageResolution:
    fallback = _normalize_language_code(default_language) or "en"
    if source_country is None or not str(source_country).strip():
        return CaptionLanguageResolution(
            language=fallback,
            source_country=None,
            fallback_used=True,
            reason="missing-source-country",
        )
    text = str(source_country).strip()
    normalized_country = normalize_country(text)
    if normalized_country in DIRECT_LANGUAGE_CODES:
        return CaptionLanguageResolution(
            language=normalized_country,
            source_country=text,
            fallback_used=False,
            reason="direct-language-code",
        )
    language = COUNTRY_LANGUAGE_CODES.get(normalized_country) or COUNTRY_LANGUAGE_CODES.get(normalize_title(text))
    if language:
        return CaptionLanguageResolution(
            language=language,
            source_country=text,
            fallback_used=False,
            reason="mapped-source-country",
        )
    return CaptionLanguageResolution(
        language=fallback,
        source_country=text,
        fallback_used=True,
        reason="unknown-source-country",
    )


def _normalize_language_code(value: str | None) -> str | None:
    if value is None:
        return None
    code = str(value).strip().casefold()
    if not code:
        return None
    return code.split("-", 1)[0]


def _unique_languages(values: list[str | None]) -> list[str]:
    languages: list[str] = []
    for value in values:
        code = _normalize_language_code(value)
        if code and code not in languages:
            languages.append(code)
    return languages or ["en"]


def _transcript_error_reason(error: Exception) -> str:
    name = type(error).__name__
    if name == "NoTranscriptFound":
        return "language_unavailable"
    if name == "NoTranscriptAvailable":
        return "no_transcript"
    if name == "TranscriptsDisabled":
        return "transcripts_disabled"
    if name == "VideoUnavailable":
        return "video_unavailable"
    return "fetch_error"


def _transcript_language(transcript: Any, *, fallback: str) -> str:
    return str(getattr(transcript, "language_code", None) or getattr(transcript, "language", None) or fallback).strip() or fallback


def _parse_transcript_api_snippets(snippets: Any, *, language: str) -> list[SubtitleSegment]:
    segments: list[SubtitleSegment] = []
    for snippet in snippets or []:
        text = " ".join(str(_snippet_value(snippet, "text", "")).split())
        if not text:
            continue
        try:
            start_ms = int(float(_snippet_value(snippet, "start", 0)) * 1000)
            duration_ms = int(float(_snippet_value(snippet, "duration", 0)) * 1000)
        except (TypeError, ValueError):
            continue
        if duration_ms <= 0:
            continue
        segments.append(SubtitleSegment(start_ms=start_ms, end_ms=start_ms + duration_ms, text=text, language=language))
    return segments


def _snippet_value(snippet: Any, key: str, default: Any) -> Any:
    if isinstance(snippet, dict):
        return snippet.get(key, default)
    return getattr(snippet, key, default)


class WebSubClient:
    def __init__(self, *, callback_url: str, http: HttpClient | None = None, hub_url: str = WEBSUB_HUB_URL):
        self.callback_url = callback_url
        self.http = http or _UrllibHttpClient()
        self.hub_url = hub_url

    def subscribe(self, channel_id: str, *, mode: str = "subscribe", lease_seconds: int = 864000) -> bool:
        response = self.http.post(
            self.hub_url,
            data={
                "hub.mode": mode,
                "hub.topic": f"{YOUTUBE_FEED_URL}?channel_id={channel_id}",
                "hub.callback": self.callback_url,
                "hub.verify": "async",
                "hub.lease_seconds": str(lease_seconds),
            },
            timeout=15,
        )
        return 200 <= int(response.status_code) < 300

    def renew(self, channel_id: str, *, lease_seconds: int = 864000) -> bool:
        return self.subscribe(channel_id, mode="subscribe", lease_seconds=lease_seconds)


def validate_websub_callback(body: bytes, headers: dict[str, str], secret: str) -> None:
    if not secret:
        return
    signature = _header(headers, "x-hub-signature-256")
    if not signature:
        raise CallbackValidationError("Missing WebSub signature")
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise CallbackValidationError("Invalid WebSub signature")


def parse_websub_video_ids(body: bytes) -> list[str]:
    root = ET.fromstring(body)
    namespace = {"yt": "http://www.youtube.com/xml/schemas/2015", "atom": "http://www.w3.org/2005/Atom"}
    ids = [node.text.strip() for node in root.findall(".//yt:videoId", namespace) if node.text and node.text.strip()]
    if ids:
        return ids
    return [node.text.strip() for node in root.findall(".//videoId") if node.text and node.text.strip()]


def _parse_timed_text(text: str, *, language: str) -> list[SubtitleSegment]:
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    segments: list[SubtitleSegment] = []
    for node in root.findall(".//text"):
        body = " ".join((node.text or "").split())
        if not body:
            continue
        try:
            start_ms = int(float(node.attrib.get("start", "0")) * 1000)
            duration_ms = int(float(node.attrib.get("dur", "0")) * 1000)
        except ValueError:
            continue
        if duration_ms <= 0:
            continue
        segments.append(SubtitleSegment(start_ms=start_ms, end_ms=start_ms + duration_ms, text=body, language=language))
    return segments


def _live_status(item: dict[str, Any]) -> str:
    details = item.get("liveStreamingDetails") or {}
    if details.get("actualEndTime"):
        return "completed"
    if details.get("actualStartTime") or details.get("scheduledStartTime"):
        return "live"
    return "none"


def _extract_handle(source: str) -> str:
    text = source.strip()
    if not text:
        return ""
    if text.startswith("@"):
        return text[1:].split("/", 1)[0].split("?", 1)[0].split("#", 1)[0].strip()
    parsed = urllib.parse.urlparse(text if "://" in text else f"https://{text}")
    for segment in parsed.path.split("/"):
        if segment.startswith("@") and len(segment) > 1:
            return segment[1:].strip()
    return ""


def _extract_channel_id(source: str) -> str | None:
    text = source.strip().strip("/")
    if text.startswith("UC"):
        return text
    marker = "/channel/"
    if marker in text:
        return text.rsplit(marker, 1)[1].split("/", 1)[0]
    return None


def _header(headers: dict[str, str], name: str) -> str | None:
    lowered = name.casefold()
    for key, value in headers.items():
        if key.casefold() == lowered:
            return value
    return None


class _UrllibResponse:
    def __init__(self, status_code: int, text: str):
        self.status_code = status_code
        self.text = text

    def json(self) -> dict[str, Any]:
        return json.loads(self.text)


class _UrllibHttpClient:
    def get(self, url: str, params: dict[str, Any]) -> _UrllibResponse:
        encoded = urllib.parse.urlencode(params)
        with urllib.request.urlopen(f"{url}?{encoded}", timeout=15) as response:
            return _UrllibResponse(response.status, response.read().decode("utf-8"))

    def post(self, url: str, data: dict[str, Any], timeout: int) -> _UrllibResponse:
        encoded = urllib.parse.urlencode(data).encode("utf-8")
        request = urllib.request.Request(url, data=encoded, method="POST")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return _UrllibResponse(response.status, response.read().decode("utf-8"))
