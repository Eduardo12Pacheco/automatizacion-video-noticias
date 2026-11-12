from __future__ import annotations

import hashlib
import html
import hmac
import json
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from .title_matcher import normalize_country, normalize_title


YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"
WEBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/subscribe"
YOUTUBE_FEED_URL = "https://www.youtube.com/xml/feeds/videos.xml"
NETWORK_MODE_PROTECTED = "protected"


class PolicyForbiddenLocalYouTube(RuntimeError):
    pass


def _guard_local_youtube_policy(network_mode: str | None) -> None:
    if str(network_mode or "").strip().casefold() == NETWORK_MODE_PROTECTED:
        raise PolicyForbiddenLocalYouTube("policy_forbidden_local_youtube")


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
    def __init__(self, *, api_key: str, http: HttpClient | None = None, network_mode: str | None = None):
        _guard_local_youtube_policy(network_mode)
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
        network_mode: str | None = None,
    ):
        _guard_local_youtube_policy(network_mode)
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
        try:
            transcript = _select_original_transcript(transcript_list)
            if transcript is not None:
                return transcript
        except Exception:
            pass

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


class CompositeSubtitleProvider:
    def __init__(self, *, primary: SubtitleProvider, fallback: SubtitleProvider):
        self.primary = primary
        self.fallback = fallback

    def fetch(self, *, video_id: str, source_language: str | None, default_language: str) -> list[SubtitleSegment]:
        try:
            return self.primary.fetch(video_id=video_id, source_language=source_language, default_language=default_language)
        except SubtitleUnavailable:
            return self.fallback.fetch(video_id=video_id, source_language=source_language, default_language=default_language)


@dataclass(frozen=True)
class _YtDlpSubtitleChoice:
    language: str
    source: str


class YtDlpSubtitleProvider:
    provider_name = "yt-dlp-subtitles"

    def __init__(
        self,
        *,
        binary: str = "yt-dlp",
        cookies_path: Path | str | None = None,
        runner: Callable[[list[str], Path], Any] | None = None,
        network_mode: str | None = None,
    ):
        _guard_local_youtube_policy(network_mode)
        self.binary = binary or "yt-dlp"
        self.cookies_path = Path(cookies_path) if cookies_path else None
        self.runner = runner or _run_yt_dlp

    def fetch(self, *, video_id: str, source_language: str | None, default_language: str) -> list[SubtitleSegment]:
        resolution = resolve_caption_language(source_country=source_language, default_language=default_language)
        details = {
            "provider": self.provider_name,
            "reason": "unavailable",
            "video_id": video_id,
            "source_language": source_language,
            "default_language": default_language,
            "resolution_reason": resolution.reason,
            "fallback_used": resolution.fallback_used,
        }
        try:
            with tempfile.TemporaryDirectory(prefix="channel-monitor-ytdlp-") as tmp:
                workdir = Path(tmp)
                info = self._dump_info(video_id, workdir)
                choice = _choose_yt_dlp_subtitle(info, preferred_language=resolution.language)
                if choice is None:
                    raise SubtitleUnavailable(video_id, resolution.language, reason="no_subtitles", details={**details, "reason": "no_subtitles"})
                self._download_subtitle(video_id, workdir, choice)
                segments = _parse_downloaded_subtitle_files(workdir, language=choice.language)
        except SubtitleUnavailable:
            raise
        except Exception as exc:
            raise SubtitleUnavailable(
                video_id,
                resolution.language,
                reason="fetch_error",
                details={**details, "reason": "fetch_error", "error_type": type(exc).__name__, "error": str(exc)},
            ) from exc
        if not segments:
            raise SubtitleUnavailable(video_id, choice.language, reason="empty_transcript", details={**details, "reason": "empty_transcript"})
        return segments

    def _base_args(self) -> list[str]:
        args = [self.binary, "--skip-download", "--no-playlist"]
        if self.cookies_path and self.cookies_path.exists():
            args.extend(["--cookies", str(self.cookies_path)])
        return args

    def _dump_info(self, video_id: str, workdir: Path) -> dict[str, Any]:
        result = self.runner([*self._base_args(), "--dump-json", _video_url(video_id)], workdir)
        if int(getattr(result, "returncode", 1)) != 0:
            raise RuntimeError(_yt_dlp_error(result))
        return json.loads(str(getattr(result, "stdout", "") or "{}"))

    def _download_subtitle(self, video_id: str, workdir: Path, choice: _YtDlpSubtitleChoice) -> None:
        write_flag = "--write-auto-subs" if choice.source == "automatic" else "--write-subs"
        result = self.runner(
            [
                *self._base_args(),
                write_flag,
                "--sub-langs",
                choice.language,
                "--sub-format",
                "vtt/json3/srv3/srv2/srv1",
                "--output",
                "%(id)s.%(ext)s",
                _video_url(video_id),
            ],
            workdir,
        )
        if int(getattr(result, "returncode", 1)) != 0:
            raise RuntimeError(_yt_dlp_error(result))


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


def _select_original_transcript(transcript_list: Any) -> Any | None:
    transcripts = [transcript for transcript in list(transcript_list) if not _is_translated_transcript(transcript)]
    manual = [transcript for transcript in transcripts if not bool(getattr(transcript, "is_generated", False))]
    if manual:
        return manual[0]
    if transcripts:
        return transcripts[0]
    return None


def _is_translated_transcript(transcript: Any) -> bool:
    for attribute in ("is_translated", "translated"):
        value = getattr(transcript, attribute, None)
        if isinstance(value, bool):
            return value
    for attribute in ("_translation_language", "translation_language", "translation_language_code"):
        if getattr(transcript, attribute, None):
            return True
    return False


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


def _run_yt_dlp(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=str(cwd), capture_output=True, text=True, timeout=90)


def _yt_dlp_error(result: Any) -> str:
    text = str(getattr(result, "stderr", "") or getattr(result, "stdout", "") or "yt-dlp failed")
    return " ".join(text.split())[:500]


def _choose_yt_dlp_subtitle(info: dict[str, Any], *, preferred_language: str) -> _YtDlpSubtitleChoice | None:
    video_language = _normalize_language_code(info.get("language"))
    for source, tracks in (("manual", info.get("subtitles") or {}), ("automatic", info.get("automatic_captions") or {})):
        languages = _ordered_yt_dlp_languages(tracks, preferred_language=video_language or preferred_language)
        for language in languages:
            entries = tracks.get(language) or []
            if entries and not _looks_translated_caption(language, entries):
                return _YtDlpSubtitleChoice(language=language, source=source)
    return None


def _ordered_yt_dlp_languages(tracks: dict[str, Any], *, preferred_language: str | None) -> list[str]:
    languages = [str(language) for language in tracks.keys()]
    preferred_base = _normalize_language_code(preferred_language)
    return sorted(languages, key=lambda language: (0 if _normalize_language_code(language) == preferred_base else 1, language))


def _looks_translated_caption(language: str, entries: list[Any]) -> bool:
    if language.startswith("live_chat"):
        return True
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or entry.get("format") or "").casefold()
        if "translated" in name or " from " in name or " auto-translated" in name:
            return True
    return False


def _parse_downloaded_subtitle_files(workdir: Path, *, language: str) -> list[SubtitleSegment]:
    files = sorted(
        path
        for path in workdir.iterdir()
        if path.is_file() and path.suffix.lower().lstrip(".") in {"vtt", "json3", "srv1", "srv2", "srv3", "xml"}
    )
    for path in files:
        text = path.read_text(encoding="utf-8", errors="replace")
        suffix = path.suffix.lower().lstrip(".")
        if suffix == "vtt":
            segments = _parse_vtt_subtitles(text, language=language)
        elif suffix == "json3":
            segments = _parse_json3_subtitles(text, language=language)
        else:
            segments = _parse_srv_subtitles(text, language=language)
        if segments:
            return segments
    return []


def _parse_vtt_subtitles(text: str, *, language: str) -> list[SubtitleSegment]:
    segments: list[SubtitleSegment] = []
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        index += 1
        if "-->" not in line:
            continue
        left, right = line.split("-->", 1)
        start_ms = _parse_vtt_timestamp(left.strip())
        end_ms = _parse_vtt_timestamp(right.strip().split(" ", 1)[0])
        body: list[str] = []
        while index < len(lines) and lines[index].strip():
            body.append(lines[index].strip())
            index += 1
        text_body = _clean_subtitle_text(" ".join(body))
        if start_ms is not None and end_ms is not None and end_ms > start_ms and text_body:
            segments.append(SubtitleSegment(start_ms=start_ms, end_ms=end_ms, text=text_body, language=language))
    return segments


def _parse_vtt_timestamp(value: str) -> int | None:
    match = re.match(r"(?:(\d+):)?(\d{2}):(\d{2})[\.,](\d{3})", value)
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2))
    seconds = int(match.group(3))
    millis = int(match.group(4))
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis


def _parse_json3_subtitles(text: str, *, language: str) -> list[SubtitleSegment]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return []
    segments: list[SubtitleSegment] = []
    for event in payload.get("events") or []:
        snippets = event.get("segs") if isinstance(event, dict) else None
        if not snippets:
            continue
        body = _clean_subtitle_text("".join(str(snippet.get("utf8") or "") for snippet in snippets if isinstance(snippet, dict)))
        if not body:
            continue
        start_ms = int(event.get("tStartMs") or 0)
        duration_ms = int(event.get("dDurationMs") or 0)
        if duration_ms > 0:
            segments.append(SubtitleSegment(start_ms=start_ms, end_ms=start_ms + duration_ms, text=body, language=language))
    return segments


def _parse_srv_subtitles(text: str, *, language: str) -> list[SubtitleSegment]:
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    segments: list[SubtitleSegment] = []
    for node in root.findall(".//text") + root.findall(".//p"):
        body = _clean_subtitle_text("".join(node.itertext()))
        if not body:
            continue
        try:
            start_ms = int(float(node.attrib.get("start", node.attrib.get("t", "0"))) * (1 if "t" in node.attrib else 1000))
            duration_ms = int(float(node.attrib.get("dur", node.attrib.get("d", "0"))) * (1 if "d" in node.attrib else 1000))
        except ValueError:
            continue
        if duration_ms > 0:
            segments.append(SubtitleSegment(start_ms=start_ms, end_ms=start_ms + duration_ms, text=body, language=language))
    return segments


def _clean_subtitle_text(value: str) -> str:
    without_tags = re.sub(r"<[^>]+>", "", value)
    return " ".join(html.unescape(without_tags).split())


def _video_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _snippet_value(snippet: Any, key: str, default: Any) -> Any:
    if isinstance(snippet, dict):
        return snippet.get(key, default)
    return getattr(snippet, key, default)


class WebSubClient:
    def __init__(self, *, callback_url: str, http: HttpClient | None = None, hub_url: str = WEBSUB_HUB_URL, network_mode: str | None = None):
        _guard_local_youtube_policy(network_mode)
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
