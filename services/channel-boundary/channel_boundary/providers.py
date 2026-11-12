from __future__ import annotations

from typing import Any, Mapping

from .errors import BoundaryProviderError
from .http import UrllibJsonHttpClient
from .youtube import (
    YOUTUBE_DATA_API_BASE,
    YOUTUBE_TIMEDTEXT_BASE,
    YOUTUBE_WATCH_BASE,
    YOUTUBE_WEBSUB_FEED_URL,
    YOUTUBE_WEBSUB_HUB_URL,
    caption_track_json3_url,
    caption_tracks_from_watch_html,
    channel_from_item,
    choose_caption_track,
    choose_timedtext_track,
    first_item,
    parse_channel_source,
    preferred_subtitle_language,
    positive_int,
    required_text,
    timedtext_params_for_track,
    timedtext_segments_from_json3,
    timedtext_segments_from_xml,
    timedtext_tracks_from_xml,
    upload_items_from_response,
    video_metadata_from_item,
)


class MockChannelBoundaryProvider:
    provider_name = "mock"

    def resolve_channel(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        source = required_text(payload, "source")
        return {"channel_id": "UC_MOCK_CHANNEL", "title": f"Mock channel for {source}", "uploads_playlist_id": "UU_MOCK_UPLOADS"}

    def video_metadata(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        video_id = required_text(payload, "video_id")
        return {
            "video_id": video_id,
            "channel_id": "UC_MOCK_CHANNEL",
            "title": f"Mock video {video_id}",
            "published_at": None,
            "live_status": "none",
        }

    def uploads_playlist(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        uploads_playlist_id = required_text(payload, "uploads_playlist_id")
        item_limit = positive_int(payload.get("item_limit"), default=25, maximum=50)
        page_limit = positive_int(payload.get("page_limit"), default=1, maximum=5)
        return {
            "uploads_playlist_id": uploads_playlist_id,
            "page_limit": page_limit,
            "item_limit": item_limit,
            "items": [
                {"video_id": "mock-video-1", "published_at": None, "page_token": None},
            ][:item_limit],
        }

    def subtitles(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        video_id = required_text(payload, "video_id")
        language = preferred_subtitle_language(payload)
        return {"video_id": video_id, "segments": [{"start_ms": 0, "end_ms": 1000, "text": "mock subtitle", "language": language}]}

    def renew_websub(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        channel_id = required_text(payload, "channel_id")
        lease_seconds = positive_int(payload.get("lease_seconds"), default=864000, maximum=864000)
        return {"accepted": True, "channel_id": channel_id, "lease_seconds": lease_seconds, "expires_at": None}


class YouTubeDataBoundaryProvider:
    provider_name = "youtube"

    def __init__(
        self,
        *,
        api_key: str,
        http_client: Any | None = None,
        max_page_limit: int = 5,
        max_item_limit: int = 50,
        public_callback_url: str = "",
        websub_verify_token: str = "",
    ):
        if not str(api_key).strip():
            raise BoundaryProviderError("boundary_misconfigured", "YouTube Data API key is required", retryable=False, status=500)
        self.api_key = str(api_key).strip()
        self.http_client = http_client or UrllibJsonHttpClient()
        self.max_page_limit = max_page_limit
        self.max_item_limit = max_item_limit
        self.public_callback_url = str(public_callback_url).strip()
        self.websub_verify_token = str(websub_verify_token).strip()

    def resolve_channel(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        source = required_text(payload, "source")
        selector = parse_channel_source(source)
        try:
            if "q" in selector:
                search = self._get(
                    "search",
                    {"part": "snippet", "type": "channel", "maxResults": 1, "q": selector["q"]},
                )
                search_item = first_item(search, not_found_code="channel_not_found", not_found_message="YouTube channel was not found")
                id_value = search_item.get("id") if isinstance(search_item.get("id"), dict) else {}
                selector = {"id": str(id_value.get("channelId") or "")}
            channel = self._get("channels", {"part": "snippet,contentDetails", **selector})
            return channel_from_item(first_item(channel, not_found_code="channel_not_found", not_found_message="YouTube channel was not found"))
        except BoundaryProviderError:
            raise
        except Exception as exc:  # noqa: BLE001 - provider boundary maps unknown upstream failures.
            raise BoundaryProviderError("boundary_upstream_failed", "YouTube Data API request failed", retryable=True, status=502) from exc

    def video_metadata(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        video_id = required_text(payload, "video_id")
        try:
            response = self._get("videos", {"part": "snippet,liveStreamingDetails,status", "id": video_id})
            item = first_item(response, not_found_code="video_not_found", not_found_message="YouTube video was not found")
            return video_metadata_from_item(item, requested_video_id=video_id)
        except BoundaryProviderError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise BoundaryProviderError("boundary_upstream_failed", "YouTube Data API request failed", retryable=True, status=502) from exc

    def uploads_playlist(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        playlist_id = required_text(payload, "uploads_playlist_id")
        page_limit = positive_int(payload.get("page_limit"), default=1, maximum=self.max_page_limit)
        item_limit = positive_int(payload.get("item_limit"), default=25, maximum=self.max_item_limit)
        items: list[dict[str, Any]] = []
        page_token = None
        try:
            for _page in range(page_limit):
                remaining = item_limit - len(items)
                if remaining <= 0:
                    break
                response = self._get(
                    "playlistItems",
                    {
                        "part": "contentDetails",
                        "playlistId": playlist_id,
                        "maxResults": min(50, remaining),
                        "pageToken": page_token,
                    },
                )
                items.extend(upload_items_from_response(response, remaining=remaining))
                page_token = response.get("nextPageToken") if isinstance(response, dict) else None
                if not page_token:
                    break
            return {"uploads_playlist_id": playlist_id, "page_limit": page_limit, "item_limit": item_limit, "items": items[:item_limit]}
        except BoundaryProviderError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise BoundaryProviderError("boundary_upstream_failed", "YouTube Data API request failed", retryable=True, status=502) from exc

    def _get(self, resource: str, params: Mapping[str, Any]) -> dict[str, Any]:
        return self.http_client.get_json(f"{YOUTUBE_DATA_API_BASE}/{resource}", {**params, "key": self.api_key})

    def subtitles(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        video_id = required_text(payload, "video_id")
        language = preferred_subtitle_language(payload)
        default_language = str(payload.get("default_language") or "en").strip() or "en"
        try:
            body = self.http_client.get_text(YOUTUBE_TIMEDTEXT_BASE, {"v": video_id, "lang": language})
            segments = timedtext_segments_from_xml(body, language=language)
            return {"video_id": video_id, "segments": segments}
        except BoundaryProviderError as error:
            if error.code != "subtitles_unavailable":
                raise
            fallback = self._subtitles_from_track_list(video_id, preferred_language=language, default_language=default_language)
            if fallback is not None:
                return {"video_id": video_id, "segments": fallback["segments"]}
            player_fallback = self._subtitles_from_watch_player(video_id, preferred_language=language, default_language=default_language)
            if player_fallback is not None:
                return {"video_id": video_id, "segments": player_fallback["segments"]}
            raise BoundaryProviderError(error.code, error.message, retryable=error.retryable, status=error.status) from error
        except Exception as exc:  # noqa: BLE001
            raise BoundaryProviderError("boundary_upstream_failed", "YouTube timedtext request failed", retryable=True, status=502) from exc

    def _subtitles_from_track_list(self, video_id: str, *, preferred_language: str, default_language: str) -> dict[str, Any] | None:
        try:
            list_body = self.http_client.get_text(YOUTUBE_TIMEDTEXT_BASE, {"v": video_id, "type": "list"})
            tracks = timedtext_tracks_from_xml(list_body)
            track = choose_timedtext_track(tracks, preferred_language=preferred_language, default_language=default_language)
            body = self.http_client.get_text(YOUTUBE_TIMEDTEXT_BASE, timedtext_params_for_track(video_id, track))
            return {"segments": timedtext_segments_from_xml(body, language=track["lang"])}
        except BoundaryProviderError:
            return None
        except Exception:  # noqa: BLE001 - fallback failures preserve the original unavailable result.
            return None

    def _subtitles_from_watch_player(self, video_id: str, *, preferred_language: str, default_language: str) -> dict[str, Any] | None:
        try:
            html = self.http_client.get_text(YOUTUBE_WATCH_BASE, {"v": video_id, "hl": default_language})
            tracks = caption_tracks_from_watch_html(html)
            track = choose_caption_track(tracks, preferred_language=preferred_language, default_language=default_language)
            body = self.http_client.get_text(caption_track_json3_url(track), {})
            return {"segments": timedtext_segments_from_json3(body, language=track["lang"])}
        except BoundaryProviderError:
            return None
        except Exception:  # noqa: BLE001 - fallback failures preserve the original unavailable result.
            return None

    def renew_websub(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        channel_id = required_text(payload, "channel_id")
        lease_seconds = positive_int(payload.get("lease_seconds"), default=864000, maximum=864000)
        if not self.public_callback_url:
            raise BoundaryProviderError("websub_misconfigured", "Cloud WebSub callback URL is not configured", retryable=False, status=503)
        form = {
            "hub.mode": "subscribe",
            "hub.topic": f"{YOUTUBE_WEBSUB_FEED_URL}?channel_id={channel_id}",
            "hub.callback": self.public_callback_url,
            "hub.verify": "async",
            "hub.lease_seconds": str(lease_seconds),
        }
        if self.websub_verify_token:
            form["hub.verify_token"] = self.websub_verify_token
        try:
            response = self.http_client.post_form(YOUTUBE_WEBSUB_HUB_URL, form)
        except BoundaryProviderError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise BoundaryProviderError("websub_hub_rejected", "YouTube WebSub hub request failed", retryable=True, status=502) from exc
        status_code = int(response.get("status_code") or 0) if isinstance(response, dict) else 0
        if not 200 <= status_code < 300:
            raise BoundaryProviderError("websub_hub_rejected", "YouTube WebSub hub rejected the request", retryable=True, status=502)
        return {"accepted": True, "channel_id": channel_id, "lease_seconds": lease_seconds, "expires_at": None}
