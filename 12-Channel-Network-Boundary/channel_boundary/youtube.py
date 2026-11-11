from __future__ import annotations

import re
import json
from typing import Any, Mapping
from xml.etree import ElementTree

from .errors import BoundaryProviderError


YOUTUBE_DATA_API_BASE = "https://www.googleapis.com/youtube/v3"
YOUTUBE_TIMEDTEXT_BASE = "https://video.google.com/timedtext"
YOUTUBE_WATCH_BASE = "https://www.youtube.com/watch"
YOUTUBE_WEBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/subscribe"
YOUTUBE_WEBSUB_FEED_URL = "https://www.youtube.com/xml/feeds/videos.xml"
CHANNEL_ID_PATTERN = re.compile(r"^UC[0-9A-Za-z_-]{3,}$")


def required_text(payload: Mapping[str, Any], field: str) -> str:
    value = optional_text(payload.get(field))
    if not value:
        raise BoundaryProviderError("invalid_request", f"{field} is required", retryable=False, status=400)
    return value


def optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def preferred_subtitle_language(payload: Mapping[str, Any]) -> str:
    return optional_text(payload.get("source_language")) or optional_text(payload.get("default_language")) or "en"


def positive_int(value: Any, *, default: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return min(max(1, number), maximum)


def parse_channel_source(source: str) -> dict[str, str]:
    text = source.strip()
    if CHANNEL_ID_PATTERN.match(text):
        return {"id": text}
    handle_match = re.search(r"(?:youtube\.com/)?@([0-9A-Za-z_.-]+)", text)
    if handle_match:
        return {"forHandle": handle_match.group(1)}
    return {"q": text}


def channel_from_item(item: Mapping[str, Any]) -> dict[str, Any]:
    snippet = item.get("snippet") if isinstance(item.get("snippet"), dict) else {}
    content = item.get("contentDetails") if isinstance(item.get("contentDetails"), dict) else {}
    related = content.get("relatedPlaylists") if isinstance(content.get("relatedPlaylists"), dict) else {}
    channel_id = optional_text(item.get("id"))
    title = optional_text(snippet.get("title"))
    uploads = optional_text(related.get("uploads"))
    if not channel_id or not title or not uploads:
        raise BoundaryProviderError("boundary_upstream_failed", "YouTube channel payload is incomplete", retryable=True, status=502)
    return {"channel_id": channel_id, "title": title, "uploads_playlist_id": uploads}


def video_metadata_from_item(item: Mapping[str, Any], *, requested_video_id: str) -> dict[str, Any]:
    snippet = item.get("snippet") if isinstance(item.get("snippet"), dict) else {}
    return {
        "video_id": optional_text(item.get("id")) or requested_video_id,
        "channel_id": optional_text(snippet.get("channelId")),
        "title": optional_text(snippet.get("title")),
        "published_at": optional_text(snippet.get("publishedAt")),
        "live_status": optional_text(snippet.get("liveBroadcastContent")) or "none",
    }


def upload_items_from_response(response: Mapping[str, Any], *, remaining: int) -> list[dict[str, Any]]:
    items = response.get("items") if isinstance(response.get("items"), list) else []
    mapped: list[dict[str, Any]] = []
    next_page = optional_text(response.get("nextPageToken"))
    for item in items:
        if not isinstance(item, dict):
            continue
        content = item.get("contentDetails") if isinstance(item.get("contentDetails"), dict) else {}
        video_id = optional_text(content.get("videoId"))
        if not video_id:
            continue
        mapped.append(
            {
                "video_id": video_id,
                "published_at": optional_text(content.get("videoPublishedAt")),
                "page_token": next_page,
            }
        )
        if len(mapped) >= remaining:
            break
    return mapped


def first_item(response: Mapping[str, Any], *, not_found_code: str, not_found_message: str) -> Mapping[str, Any]:
    items = response.get("items") if isinstance(response.get("items"), list) else []
    if not items or not isinstance(items[0], dict):
        raise BoundaryProviderError(not_found_code, not_found_message, retryable=False, status=404)
    return items[0]


def timedtext_segments_from_xml(xml_text: str, *, language: str) -> list[dict[str, Any]]:
    if looks_like_bot_check(xml_text):
        raise BoundaryProviderError("youtube_bot_check", "YouTube timedtext is blocked by bot-check", retryable=False, status=403)
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        raise BoundaryProviderError("subtitles_unavailable", "YouTube timedtext subtitles are unavailable", retryable=False, status=503) from exc
    segments: list[dict[str, Any]] = []
    for element in root.findall(".//text"):
        text = optional_text("".join(element.itertext()))
        if not text:
            continue
        start_ms = seconds_to_ms(element.get("start"))
        duration_ms = seconds_to_ms(element.get("dur"))
        segments.append({"start_ms": start_ms, "end_ms": start_ms + duration_ms, "text": text, "language": language})
    if not segments:
        raise BoundaryProviderError("subtitles_unavailable", "YouTube timedtext subtitles are unavailable", retryable=False, status=503)
    return segments


def timedtext_segments_from_json3(payload: Any, *, language: str) -> list[dict[str, Any]]:
    if isinstance(payload, str):
        if looks_like_bot_check(payload):
            raise BoundaryProviderError("youtube_bot_check", "YouTube timedtext is blocked by bot-check", retryable=False, status=403)
        try:
            payload = json.loads(payload) if payload else {}
        except json.JSONDecodeError as exc:
            raise BoundaryProviderError("subtitles_unavailable", "YouTube timedtext subtitles are unavailable", retryable=False, status=503) from exc
    events = payload.get("events") if isinstance(payload, dict) else []
    segments: list[dict[str, Any]] = []
    for event in events if isinstance(events, list) else []:
        if not isinstance(event, dict):
            continue
        text = optional_text("".join(str(seg.get("utf8") or "") for seg in event.get("segs") or [] if isinstance(seg, dict)))
        if not text:
            continue
        start_ms = max(0, int(event.get("tStartMs") or 0))
        duration_ms = max(0, int(event.get("dDurationMs") or 0))
        segments.append({"start_ms": start_ms, "end_ms": start_ms + duration_ms, "text": text, "language": language})
    if not segments:
        raise BoundaryProviderError("subtitles_unavailable", "YouTube timedtext subtitles are unavailable", retryable=False, status=503)
    return segments


def timedtext_tracks_from_xml(xml_text: str) -> list[dict[str, str]]:
    if looks_like_bot_check(xml_text):
        raise BoundaryProviderError("youtube_bot_check", "YouTube timedtext is blocked by bot-check", retryable=False, status=403)
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        raise BoundaryProviderError("subtitles_unavailable", "YouTube timedtext track list is unavailable", retryable=False, status=503) from exc
    tracks: list[dict[str, str]] = []
    for element in root.findall(".//track"):
        language = optional_text(element.get("lang_code"))
        if not language:
            continue
        track = {"lang": language}
        name = optional_text(element.get("name"))
        kind = optional_text(element.get("kind"))
        if name:
            track["name"] = name
        if kind:
            track["kind"] = kind
        tracks.append(track)
    if not tracks:
        raise BoundaryProviderError("subtitles_unavailable", "YouTube timedtext track list is unavailable", retryable=False, status=503)
    return tracks


def choose_timedtext_track(tracks: list[dict[str, str]], *, preferred_language: str, default_language: str) -> dict[str, str]:
    language_order = [preferred_language, default_language, "en"]
    for language in language_order:
        normalized = optional_text(language)
        if not normalized:
            continue
        for track in tracks:
            if track.get("lang") == normalized:
                return track
    return tracks[0]


def timedtext_params_for_track(video_id: str, track: Mapping[str, str]) -> dict[str, str]:
    params = {"v": video_id, "lang": track["lang"]}
    if track.get("name"):
        params["name"] = track["name"]
    if track.get("kind"):
        params["kind"] = track["kind"]
    return params


def caption_tracks_from_watch_html(html: str) -> list[dict[str, str]]:
    if looks_like_bot_check(html):
        raise BoundaryProviderError("youtube_bot_check", "YouTube watch page is blocked by bot-check", retryable=False, status=403)
    player = _extract_yt_initial_player_response(html)
    captions = player.get("captions") if isinstance(player, dict) else {}
    renderer = captions.get("playerCaptionsTracklistRenderer") if isinstance(captions, dict) else {}
    raw_tracks = renderer.get("captionTracks") if isinstance(renderer, dict) else []
    tracks: list[dict[str, str]] = []
    for raw_track in raw_tracks if isinstance(raw_tracks, list) else []:
        if not isinstance(raw_track, dict):
            continue
        language = optional_text(raw_track.get("languageCode"))
        base_url = optional_text(raw_track.get("baseUrl"))
        if language and base_url:
            tracks.append({"lang": language, "baseUrl": base_url})
    if not tracks:
        raise BoundaryProviderError("subtitles_unavailable", "YouTube caption tracks are unavailable", retryable=False, status=503)
    return tracks


def choose_caption_track(tracks: list[dict[str, str]], *, preferred_language: str, default_language: str) -> dict[str, str]:
    return choose_timedtext_track(tracks, preferred_language=preferred_language, default_language=default_language)


def caption_track_json3_url(track: Mapping[str, str]) -> str:
    base_url = track["baseUrl"]
    separator = "&" if "?" in base_url else "?"
    return f"{base_url}{separator}fmt=json3"


def _extract_yt_initial_player_response(html: str) -> dict[str, Any]:
    marker = "ytInitialPlayerResponse"
    marker_index = html.find(marker)
    if marker_index < 0:
        raise BoundaryProviderError("subtitles_unavailable", "YouTube player response is unavailable", retryable=False, status=503)
    start = html.find("{", marker_index)
    if start < 0:
        raise BoundaryProviderError("subtitles_unavailable", "YouTube player response is unavailable", retryable=False, status=503)
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(html)):
        char = html[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(html[start : index + 1])
                except json.JSONDecodeError as exc:
                    raise BoundaryProviderError("subtitles_unavailable", "YouTube player response is unavailable", retryable=False, status=503) from exc
                if isinstance(parsed, dict):
                    return parsed
                break
    raise BoundaryProviderError("subtitles_unavailable", "YouTube player response is unavailable", retryable=False, status=503)


def looks_like_bot_check(text: str) -> bool:
    lowered = text.casefold()
    return "not a bot" in lowered or "captcha" in lowered or "unusual traffic" in lowered


def seconds_to_ms(value: Any) -> int:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        seconds = 0.0
    return max(0, int(round(seconds * 1000)))
