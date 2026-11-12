from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BOUNDARY_ROOT = Path(__file__).resolve().parents[1]
if str(BOUNDARY_ROOT) not in sys.path:
    sys.path.insert(0, str(BOUNDARY_ROOT))

from channel_boundary.errors import BoundaryProviderError  # noqa: E402
from channel_boundary.providers import YouTubeDataBoundaryProvider  # noqa: E402

APP_PATH = Path(__file__).resolve().parents[1] / "app.py"
APP_SPEC = importlib.util.spec_from_file_location("channel_boundary_app", APP_PATH)
boundary_app = importlib.util.module_from_spec(APP_SPEC)
assert APP_SPEC and APP_SPEC.loader
sys.modules[APP_SPEC.name] = boundary_app
APP_SPEC.loader.exec_module(boundary_app)

BoundaryConfigError = boundary_app.BoundaryConfigError
BoundaryError = boundary_app.BoundaryError
LocalEventForwarder = boundary_app.LocalEventForwarder
create_app = boundary_app.create_app
error_envelope = boundary_app.error_envelope
validate_startup_config = boundary_app.validate_startup_config


class FakeYouTubeHttpClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def get_json(self, url, params):
        self.requests.append({"url": url, "params": dict(params)})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def get_text(self, url, params):
        self.requests.append({"url": url, "params": dict(params)})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def post_form(self, url, data):
        self.requests.append({"url": url, "data": dict(data)})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def test_youtube_data_provider_resolves_handle_to_channel_contract_without_live_http():
    http = FakeYouTubeHttpClient(
        [
            {
                "items": [
                    {
                        "id": "UCRealChannel",
                        "snippet": {"title": "Real Club"},
                        "contentDetails": {"relatedPlaylists": {"uploads": "UURealUploads"}},
                    }
                ]
            }
        ]
    )
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http)

    resolved = provider.resolve_channel({"source": "https://www.youtube.com/@realclub"})

    assert resolved == {"channel_id": "UCRealChannel", "title": "Real Club", "uploads_playlist_id": "UURealUploads"}
    assert http.requests == [
        {
            "url": "https://www.googleapis.com/youtube/v3/channels",
            "params": {"part": "snippet,contentDetails", "forHandle": "realclub", "key": "data-api-key"},
        }
    ]


def test_youtube_data_provider_fetches_video_metadata_contract_without_live_http():
    http = FakeYouTubeHttpClient(
        [
            {
                "items": [
                    {
                        "id": "video-1",
                        "snippet": {
                            "channelId": "UCRealChannel",
                            "title": "Final highlights",
                            "publishedAt": "2026-06-04T19:30:00Z",
                            "liveBroadcastContent": "none",
                        },
                    }
                ]
            }
        ]
    )
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http)

    metadata = provider.video_metadata({"video_id": "video-1"})

    assert metadata == {
        "video_id": "video-1",
        "channel_id": "UCRealChannel",
        "title": "Final highlights",
        "published_at": "2026-06-04T19:30:00Z",
        "live_status": "none",
    }
    assert http.requests[0]["params"] == {"part": "snippet,liveStreamingDetails,status", "id": "video-1", "key": "data-api-key"}


def test_youtube_data_provider_fetches_uploads_with_capped_fake_pagination():
    http = FakeYouTubeHttpClient(
        [
            {
                "nextPageToken": "next-page",
                "items": [
                    {"contentDetails": {"videoId": "video-1", "videoPublishedAt": "2026-06-04T19:30:00Z"}},
                    {"contentDetails": {"videoId": "video-2", "videoPublishedAt": "2026-06-05T19:30:00Z"}},
                ],
            },
            {
                "items": [
                    {"contentDetails": {"videoId": "video-3", "videoPublishedAt": "2026-06-06T19:30:00Z"}},
                ],
            },
        ]
    )
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http, max_page_limit=2, max_item_limit=3)

    uploads = provider.uploads_playlist({"uploads_playlist_id": "UURealUploads", "item_limit": 99, "page_limit": 99})

    assert uploads == {
        "uploads_playlist_id": "UURealUploads",
        "page_limit": 2,
        "item_limit": 3,
        "items": [
            {"video_id": "video-1", "published_at": "2026-06-04T19:30:00Z", "page_token": "next-page"},
            {"video_id": "video-2", "published_at": "2026-06-05T19:30:00Z", "page_token": "next-page"},
            {"video_id": "video-3", "published_at": "2026-06-06T19:30:00Z", "page_token": None},
        ],
    }
    assert [request["params"]["maxResults"] for request in http.requests] == [3, 1]
    assert http.requests[1]["params"]["pageToken"] == "next-page"


@pytest.mark.parametrize(
    ("upstream_error", "expected_code", "expected_status", "expected_retryable"),
    [
        (BoundaryProviderError("youtube_quota_exceeded", "quota exceeded", retryable=True, status=429), "youtube_quota_exceeded", 429, True),
        (BoundaryProviderError("channel_not_found", "channel not found", retryable=False, status=404), "channel_not_found", 404, False),
        (RuntimeError("socket reset"), "boundary_upstream_failed", 502, True),
    ],
)
def test_youtube_data_provider_maps_quota_not_found_and_upstream_failures_to_typed_errors(upstream_error, expected_code, expected_status, expected_retryable):
    http = FakeYouTubeHttpClient([upstream_error])
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http)

    with pytest.raises(BoundaryProviderError) as error:
        provider.resolve_channel({"source": "@realclub"})

    assert error.value.code == expected_code
    assert error.value.status == expected_status
    assert error.value.retryable is expected_retryable


def test_youtube_provider_fetches_timedtext_subtitles_contract_without_live_http():
    http = FakeYouTubeHttpClient(['<transcript><text start="1.25" dur="2.5">Gol &amp; abrazo</text></transcript>'])
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http)

    subtitles = provider.subtitles({"video_id": "video-1", "default_language": "es"})

    assert subtitles == {
        "video_id": "video-1",
        "segments": [{"start_ms": 1250, "end_ms": 3750, "text": "Gol & abrazo", "language": "es"}],
    }
    assert http.requests == [
        {
            "url": "https://video.google.com/timedtext",
            "params": {"v": "video-1", "lang": "es"},
        }
    ]


@pytest.mark.parametrize(
    ("timedtext_response", "expected_code", "expected_status", "expected_retryable"),
    [
        ("<transcript></transcript>", "subtitles_unavailable", 503, False),
        ("<html><title>Sign in to confirm you are not a bot</title></html>", "youtube_bot_check", 403, False),
        (RuntimeError("timedtext socket reset"), "boundary_upstream_failed", 502, True),
    ],
)
def test_youtube_provider_maps_timedtext_unavailable_bot_check_and_upstream_failures(timedtext_response, expected_code, expected_status, expected_retryable):
    http = FakeYouTubeHttpClient([timedtext_response])
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http)

    with pytest.raises(BoundaryProviderError) as error:
        provider.subtitles({"video_id": "video-1", "default_language": "en"})

    assert error.value.code == expected_code
    assert error.value.status == expected_status
    assert error.value.retryable is expected_retryable


def test_youtube_provider_endpoint_uses_cloud_timedtext_without_mock_or_local_fallback():
    http = FakeYouTubeHttpClient(['<transcript><text start="0" dur="1">real caption</text></transcript>'])
    app = create_app(
        environ={
            "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
            "CHANNEL_BOUNDARY_PROVIDER": "youtube",
            "CHANNEL_BOUNDARY_YOUTUBE_API_KEY": "data-api-key",
        },
        http_client=http,
    )
    client = TestClient(app)

    response = post_json(client, "/v1/subtitles/fetch", {"video_id": "video-1", "default_language": "en"})

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {"video_id": "video-1", "segments": [{"start_ms": 0, "end_ms": 1000, "text": "real caption", "language": "en"}]},
    }
    assert response.json()["data"]["segments"][0]["text"] != "mock subtitle"
    assert http.requests[0]["url"] == "https://video.google.com/timedtext"


def test_youtube_timedtext_uses_source_language_when_monitor_supplies_one():
    http = FakeYouTubeHttpClient(['<transcript><text start="2" dur="3">caption source</text></transcript>'])
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http)

    subtitles = provider.subtitles({"video_id": "video-2", "source_language": "pt", "default_language": "en"})

    assert subtitles == {
        "video_id": "video-2",
        "segments": [{"start_ms": 2000, "end_ms": 5000, "text": "caption source", "language": "pt"}],
    }
    assert http.requests == [
        {
            "url": "https://video.google.com/timedtext",
            "params": {"v": "video-2", "lang": "pt"},
        }
    ]


def test_youtube_timedtext_falls_back_to_track_list_when_preferred_language_is_unavailable():
    http = FakeYouTubeHttpClient(
        [
            "<transcript></transcript>",
            '<transcript_list><track id="0" lang_code="es" name="Español"/><track id="1" lang_code="en" name="English"/></transcript_list>',
            '<transcript><text start="3" dur="4">subtítulo real</text></transcript>',
        ]
    )
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http)

    subtitles = provider.subtitles({"video_id": "video-3", "source_language": "es", "default_language": "en"})

    assert subtitles == {
        "video_id": "video-3",
        "segments": [{"start_ms": 3000, "end_ms": 7000, "text": "subtítulo real", "language": "es"}],
    }
    assert http.requests == [
        {"url": "https://video.google.com/timedtext", "params": {"v": "video-3", "lang": "es"}},
        {"url": "https://video.google.com/timedtext", "params": {"v": "video-3", "type": "list"}},
        {"url": "https://video.google.com/timedtext", "params": {"v": "video-3", "lang": "es", "name": "Español"}},
    ]


def test_youtube_timedtext_uses_default_or_first_track_when_source_language_is_missing():
    http = FakeYouTubeHttpClient(
        [
            "<transcript></transcript>",
            '<transcript_list><track id="0" lang_code="fr" name="Français"/><track id="1" lang_code="en" kind="asr"/></transcript_list>',
            '<transcript><text start="5" dur="1.5">fallback caption</text></transcript>',
        ]
    )
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http)

    subtitles = provider.subtitles({"video_id": "video-4", "source_language": "de", "default_language": "en"})

    assert subtitles == {
        "video_id": "video-4",
        "segments": [{"start_ms": 5000, "end_ms": 6500, "text": "fallback caption", "language": "en"}],
    }
    assert http.requests[2] == {
        "url": "https://video.google.com/timedtext",
        "params": {"v": "video-4", "lang": "en", "kind": "asr"},
    }


def test_youtube_timedtext_falls_back_to_watch_caption_tracks_without_cookies_or_bypass():
    player_response = {
        "captions": {
            "playerCaptionsTracklistRenderer": {
                "captionTracks": [
                    {"languageCode": "es", "baseUrl": "https://www.youtube.com/api/timedtext?v=video-5&lang=es&name=Spanish"},
                    {"languageCode": "en", "baseUrl": "https://www.youtube.com/api/timedtext?v=video-5&lang=en"},
                ]
            }
        }
    }
    http = FakeYouTubeHttpClient(
        [
            "<transcript></transcript>",
            "<transcript_list></transcript_list>",
            f"<html><script>ytInitialPlayerResponse = {__import__('json').dumps(player_response)};</script></html>",
            {"events": [{"tStartMs": 7000, "dDurationMs": 2000, "segs": [{"utf8": "caption from player"}]}]},
        ]
    )
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=http)

    subtitles = provider.subtitles({"video_id": "video-5", "source_language": "fr", "default_language": "en"})

    assert subtitles == {
        "video_id": "video-5",
        "segments": [{"start_ms": 7000, "end_ms": 9000, "text": "caption from player", "language": "en"}],
    }
    assert http.requests[2] == {"url": "https://www.youtube.com/watch", "params": {"v": "video-5", "hl": "en"}}
    assert http.requests[3] == {"url": "https://www.youtube.com/api/timedtext?v=video-5&lang=en&fmt=json3", "params": {}}


def test_youtube_provider_renews_websub_by_posting_cloud_callback_to_hub_without_live_http():
    http = FakeYouTubeHttpClient([{"status_code": 204}])
    provider = YouTubeDataBoundaryProvider(
        api_key="data-api-key",
        http_client=http,
        public_callback_url="https://boundary.example.test/v1/websub/callback",
        websub_verify_token="verify-token",
    )

    renewal = provider.renew_websub({"channel_id": "UCRealChannel", "lease_seconds": 432000})

    assert renewal == {"accepted": True, "channel_id": "UCRealChannel", "lease_seconds": 432000, "expires_at": None}
    assert http.requests == [
        {
            "url": "https://pubsubhubbub.appspot.com/subscribe",
            "data": {
                "hub.mode": "subscribe",
                "hub.topic": "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCRealChannel",
                "hub.callback": "https://boundary.example.test/v1/websub/callback",
                "hub.verify": "async",
                "hub.lease_seconds": "432000",
                "hub.verify_token": "verify-token",
            },
        }
    ]


def test_youtube_provider_websub_renew_fails_closed_when_cloud_callback_is_missing():
    provider = YouTubeDataBoundaryProvider(api_key="data-api-key", http_client=FakeYouTubeHttpClient([]))

    with pytest.raises(BoundaryProviderError) as error:
        provider.renew_websub({"channel_id": "UCRealChannel", "lease_seconds": 3600})

    assert error.value.code == "websub_misconfigured"
    assert error.value.status == 503
    assert error.value.retryable is False


def test_youtube_provider_websub_renew_maps_hub_rejection_to_typed_failure():
    http = FakeYouTubeHttpClient([{"status_code": 500}])
    provider = YouTubeDataBoundaryProvider(
        api_key="data-api-key",
        http_client=http,
        public_callback_url="https://boundary.example.test/v1/websub/callback",
    )

    with pytest.raises(BoundaryProviderError) as error:
        provider.renew_websub({"channel_id": "UCRealChannel", "lease_seconds": 3600})

    assert error.value.code == "websub_hub_rejected"
    assert error.value.status == 502
    assert error.value.retryable is True


def test_youtube_provider_websub_renew_endpoint_uses_real_hub_fake_http_and_no_local_callback_details():
    http = FakeYouTubeHttpClient([{"status_code": 202}])
    app = create_app(
        environ={
            "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
            "CHANNEL_BOUNDARY_PROVIDER": "youtube",
            "CHANNEL_BOUNDARY_YOUTUBE_API_KEY": "data-api-key",
            "CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL": "https://boundary.example.test/v1/websub/callback",
            "CHANNEL_BOUNDARY_WEBSUB_VERIFY_TOKEN": "verify-token",
            "CHANNEL_BOUNDARY_LOCAL_EVENT_URL": "https://local.example.test/api/monitor/boundary/websub-events",
            "CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY": "local-event-key",
        },
        http_client=http,
    )
    client = TestClient(app)

    response = post_json(client, "/v1/websub/renew", {"channel_id": "UCRealChannel", "callback_url": "http://127.0.0.1/api/monitor/websub"})

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {"accepted": True, "channel_id": "UCRealChannel", "lease_seconds": 864000, "expires_at": None},
    }
    assert http.requests[0]["data"]["hub.callback"] == "https://boundary.example.test/v1/websub/callback"
    assert "127.0.0.1" not in repr(http.requests[0]["data"])


class FakeProvider:
    def resolve_channel(self, payload):
        return {"channel_id": "UCResolved", "title": f"Channel {payload['source']}", "uploads_playlist_id": "UUResolved"}

    def video_metadata(self, payload):
        if payload["video_id"] == "boom":
            raise BoundaryError(code="boundary_upstream_failed", message="upstream token secret-token failed", retryable=True, status=502)
        return {
            "video_id": payload["video_id"],
            "channel_id": "UCResolved",
            "title": "Match highlights",
            "published_at": "2026-06-01T00:00:00Z",
            "live_status": "none",
        }

    def uploads_playlist(self, payload):
        return {
            "items": [
                {"video_id": "vid-1", "published_at": "2026-06-01T00:00:00Z", "page_token": "p1"},
                {"video_id": "vid-2", "published_at": None, "page_token": None},
            ],
            "page_limit": payload["page_limit"],
            "item_limit": payload["item_limit"],
        }

    def subtitles(self, payload):
        return {"segments": [{"start_ms": 0, "end_ms": 1250, "text": "gol", "language": payload["default_language"]}]}

    def renew_websub(self, payload):
        return {"accepted": True, "channel_id": payload["channel_id"], "expires_at": "2026-06-11T00:00:00Z"}


class RecordingForwarder:
    def __init__(self):
        self.calls = []

    def forward_event(self, *, url, api_key, event):
        self.calls.append({"url": url, "api_key": api_key, "event": event})
        return {"status": "accepted", "duplicate": False}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("CHANNEL_BOUNDARY_API_TOKEN", "secret-token")
    app = create_app(provider=FakeProvider())
    return TestClient(app)


def post_json(client, path, payload, token="secret-token"):
    return client.post(path, json=payload, headers={"Authorization": f"Bearer {token}"})


def test_health_is_public_and_reports_mock_boundary_service(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"service": "channel-network-boundary", "provider": "mock"}}


def test_create_app_selects_mock_provider_from_env_and_preserves_mock_contract():
    app = create_app(environ={"CHANNEL_BOUNDARY_API_TOKEN": "secret-token", "CHANNEL_BOUNDARY_PROVIDER": "mock"})
    client = TestClient(app)

    health = client.get("/health")
    resolved = post_json(client, "/v1/channels/resolve", {"source": "@club"})

    assert health.status_code == 200
    assert health.json() == {"ok": True, "data": {"service": "channel-network-boundary", "provider": "mock"}}
    assert resolved.status_code == 200
    assert resolved.json() == {
        "ok": True,
        "data": {"channel_id": "UC_MOCK_CHANNEL", "title": "Mock channel for @club", "uploads_playlist_id": "UU_MOCK_UPLOADS"},
    }


def test_create_app_selects_youtube_provider_from_env_and_routes_endpoint_through_fake_http():
    http = FakeYouTubeHttpClient(
        [
            {
                "items": [
                    {
                        "id": "UCRealChannel",
                        "snippet": {"title": "Real Club"},
                        "contentDetails": {"relatedPlaylists": {"uploads": "UURealUploads"}},
                    }
                ]
            }
        ]
    )
    app = create_app(
        environ={
            "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
            "CHANNEL_BOUNDARY_PROVIDER": "youtube",
            "CHANNEL_BOUNDARY_YOUTUBE_API_KEY": "data-api-key",
        },
        http_client=http,
    )
    client = TestClient(app)

    health = client.get("/health")
    resolved = post_json(client, "/v1/channels/resolve", {"source": "@realclub"})

    assert health.status_code == 200
    assert health.json() == {"ok": True, "data": {"service": "channel-network-boundary", "provider": "youtube"}}
    assert resolved.status_code == 200
    assert resolved.json() == {"ok": True, "data": {"channel_id": "UCRealChannel", "title": "Real Club", "uploads_playlist_id": "UURealUploads"}}
    assert http.requests == [
        {
            "url": "https://www.googleapis.com/youtube/v3/channels",
            "params": {"part": "snippet,contentDetails", "forHandle": "realclub", "key": "data-api-key"},
        }
    ]


def test_youtube_provider_mode_without_api_key_fails_closed_without_leaking_values():
    with pytest.raises(BoundaryConfigError) as error:
        create_app(
            environ={
                "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
                "CHANNEL_BOUNDARY_PROVIDER": "youtube",
                "CHANNEL_BOUNDARY_YOUTUBE_API_KEY": "",
            }
        )

    message = str(error.value)
    assert "CHANNEL_BOUNDARY_YOUTUBE_API_KEY is required when CHANNEL_BOUNDARY_PROVIDER=youtube" in message
    assert "secret-token" not in message


def test_unknown_provider_mode_fails_closed_without_leaking_values():
    with pytest.raises(BoundaryConfigError) as error:
        create_app(environ={"CHANNEL_BOUNDARY_API_TOKEN": "secret-token", "CHANNEL_BOUNDARY_PROVIDER": "yt-dlp"})

    message = str(error.value)
    assert "CHANNEL_BOUNDARY_PROVIDER must be mock or youtube" in message
    assert "secret-token" not in message


@pytest.mark.parametrize(
    ("upstream_error", "expected_status", "expected_error"),
    [
        (
            BoundaryProviderError("youtube_quota_exceeded", "quota exhausted for data-api-key", retryable=True, status=429),
            429,
            {"code": "youtube_quota_exceeded", "message": "quota exhausted for [REDACTED]", "retryable": True},
        ),
        (
            BoundaryProviderError("channel_not_found", "channel was not found", retryable=False, status=404),
            404,
            {"code": "channel_not_found", "message": "channel was not found", "retryable": False},
        ),
        (
            RuntimeError("upstream socket reset"),
            502,
            {"code": "boundary_upstream_failed", "message": "YouTube Data API request failed", "retryable": True},
        ),
    ],
)
def test_youtube_provider_endpoint_maps_typed_errors_to_responses_without_secret_leak(upstream_error, expected_status, expected_error):
    http = FakeYouTubeHttpClient([upstream_error])
    app = create_app(
        environ={
            "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
            "CHANNEL_BOUNDARY_PROVIDER": "youtube",
            "CHANNEL_BOUNDARY_YOUTUBE_API_KEY": "data-api-key",
        },
        http_client=http,
    )
    client = TestClient(app)

    response = post_json(client, "/v1/channels/resolve", {"source": "@realclub"})

    assert response.status_code == expected_status
    assert response.json() == {"ok": False, "error": expected_error}


def test_v1_endpoints_require_valid_bearer_auth(client):
    missing = client.post("/v1/videos/metadata", json={"video_id": "vid-1"})
    wrong = post_json(client, "/v1/videos/metadata", {"video_id": "vid-1"}, token="wrong-token")

    assert missing.status_code == 401
    assert missing.json() == {"ok": False, "error": {"code": "unauthorized", "message": "Missing or invalid bearer token", "retryable": False}}
    assert wrong.status_code == 401
    assert wrong.json()["error"]["code"] == "unauthorized"


def test_mocked_metadata_uploads_subtitles_and_websub_renew_contracts(client):
    metadata = post_json(client, "/v1/videos/metadata", {"video_id": "vid-1"})
    uploads = post_json(client, "/v1/playlists/uploads", {"uploads_playlist_id": "UUResolved", "page_limit": 2, "item_limit": 25})
    subtitles = post_json(client, "/v1/subtitles/fetch", {"video_id": "vid-1", "default_language": "es"})
    renew = post_json(client, "/v1/websub/renew", {"channel_id": "UCResolved", "lease_seconds": 3600})

    assert metadata.status_code == 200
    assert metadata.json() == {
        "ok": True,
        "data": {"video_id": "vid-1", "channel_id": "UCResolved", "title": "Match highlights", "published_at": "2026-06-01T00:00:00Z", "live_status": "none"},
    }
    assert uploads.status_code == 200
    assert uploads.json()["data"]["items"] == [
        {"video_id": "vid-1", "published_at": "2026-06-01T00:00:00Z", "page_token": "p1"},
        {"video_id": "vid-2", "published_at": None, "page_token": None},
    ]
    assert subtitles.status_code == 200
    assert subtitles.json()["data"]["segments"] == [{"start_ms": 0, "end_ms": 1250, "text": "gol", "language": "es"}]
    assert renew.status_code == 200
    assert renew.json() == {"ok": True, "data": {"accepted": True, "channel_id": "UCResolved", "expires_at": "2026-06-11T00:00:00Z"}}


def test_resolve_contract_and_invalid_payload_error_envelope(client):
    resolved = post_json(client, "/v1/channels/resolve", {"source": "https://youtube.com/@club"})
    invalid = post_json(client, "/v1/videos/metadata", {})

    assert resolved.status_code == 200
    assert resolved.json() == {"ok": True, "data": {"channel_id": "UCResolved", "title": "Channel https://youtube.com/@club", "uploads_playlist_id": "UUResolved"}}
    assert invalid.status_code == 400
    assert invalid.json() == {"ok": False, "error": {"code": "invalid_request", "message": "video_id is required", "retryable": False}}


def test_typed_error_envelopes_include_retryable_flag():
    response, status = error_envelope(BoundaryError(code="boundary_upstream_failed", message="upstream unavailable", retryable=True, status=502))

    assert status == 502
    assert response == {"ok": False, "error": {"code": "boundary_upstream_failed", "message": "upstream unavailable", "retryable": True}}


def test_startup_config_rejects_cookie_captcha_or_bypass_credentials_without_leaking_values():
    with pytest.raises(BoundaryConfigError) as error:
        validate_startup_config(
            {
                "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
                "YOUTUBE_COOKIE_FILE": "<WORKSPACE>/secret-cookie.txt",
                "CAPTCHA_API_KEY": "captcha-secret",
                "BOTCHECK_BYPASS_TOKEN": "bypass-secret",
            }
        )

    message = str(error.value)
    assert "YOUTUBE_COOKIE_FILE" in message
    assert "CAPTCHA_API_KEY" in message
    assert "BOTCHECK_BYPASS_TOKEN" in message
    assert "secret-cookie" not in message
    assert "captcha-secret" not in message
    assert "bypass-secret" not in message


def test_secret_redacted_logging_for_boundary_errors(client, caplog):
    caplog.set_level(logging.WARNING, logger="channel_network_boundary")
    response = post_json(client, "/v1/videos/metadata", {"video_id": "boom", "token_hint": "secret-token"})

    assert response.status_code == 502
    assert response.json() == {"ok": False, "error": {"code": "boundary_upstream_failed", "message": "upstream token [REDACTED] failed", "retryable": True}}
    assert "boundary_upstream_failed" in caplog.text
    assert "secret-token" not in caplog.text


def test_websub_callback_get_returns_challenge_for_matching_verify_token(monkeypatch):
    monkeypatch.setenv("CHANNEL_BOUNDARY_API_TOKEN", "secret-token")
    app = create_app(
        provider=FakeProvider(),
        event_forwarder=RecordingForwarder(),
        environ={
            "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
            "CHANNEL_BOUNDARY_WEBSUB_VERIFY_TOKEN": "verify-token",
            "CHANNEL_BOUNDARY_LOCAL_EVENT_URL": "https://local.example.test/api/monitor/boundary/websub-events",
            "CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY": "local-event-key",
        },
    )
    client = TestClient(app)

    accepted = client.get(
        "/v1/websub/callback",
        params={"hub.mode": "subscribe", "hub.challenge": "challenge-value", "hub.verify_token": "verify-token"},
    )
    rejected = client.get(
        "/v1/websub/callback",
        params={"hub.mode": "subscribe", "hub.challenge": "challenge-value", "hub.verify_token": "wrong"},
    )

    assert accepted.status_code == 200
    assert accepted.text == "challenge-value"
    assert rejected.status_code == 403
    assert rejected.json()["error"]["code"] == "invalid_verify_token"


def test_websub_callback_post_normalizes_mock_payload_and_forwards_to_local_route():
    forwarder = RecordingForwarder()
    app = create_app(
        provider=FakeProvider(),
        event_forwarder=forwarder,
        environ={
            "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
            "CHANNEL_BOUNDARY_LOCAL_EVENT_URL": "https://local.example.test/api/monitor/boundary/websub-events",
            "CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY": "local-event-key",
        },
    )
    client = TestClient(app)
    body = b"""
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
      <entry><yt:channelId>UCForward</yt:channelId><yt:videoId>vid-1</yt:videoId></entry>
      <entry><yt:channelId>UCForward</yt:channelId><yt:videoId>vid-2</yt:videoId></entry>
    </feed>
    """

    response = client.post("/v1/websub/callback", content=body, headers={"X-Received-At": "2026-06-05T12:00:00Z"})

    assert response.status_code == 202
    assert response.json() == {
        "ok": True,
        "data": {
            "status": "accepted",
            "event_id": "websub:UCForward:vid-1,vid-2",
            "channel_id": "UCForward",
            "video_ids": ["vid-1", "vid-2"],
            "forwarded": True,
        },
    }
    assert forwarder.calls == [
        {
            "url": "https://local.example.test/api/monitor/boundary/websub-events",
            "api_key": "local-event-key",
            "event": {
                "event_id": "websub:UCForward:vid-1,vid-2",
                "channel_id": "UCForward",
                "video_ids": ["vid-1", "vid-2"],
                "received_at": "2026-06-05T12:00:00Z",
            },
        }
    ]


def test_local_event_forwarder_sends_machine_safe_json_headers(monkeypatch):
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback):
            return False

        def read(self):
            return b'{"status":"accepted"}'

    def fake_urlopen(request, *, timeout):
        captured["url"] = request.full_url
        captured["data"] = request.data
        captured["headers"] = {key.lower(): value for key, value in request.header_items()}
        captured["method"] = request.get_method()
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(boundary_app.urllib.request, "urlopen", fake_urlopen)

    result = LocalEventForwarder().forward_event(
        url="https://local.example.test/api/monitor/boundary/websub-events",
        api_key="test-api-key",
        event={"event_id": "websub:UCForward:vid-1", "channel_id": "UCForward", "video_ids": ["vid-1"]},
    )

    assert result == {"status": "accepted"}
    assert captured["url"] == "https://local.example.test/api/monitor/boundary/websub-events"
    assert captured["method"] == "POST"
    assert captured["timeout"] == 10
    assert captured["headers"] == {
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": "channel-network-boundary/1.0",
        "x-boundary-event-api-key": "test-api-key",
    }
    assert b'"event_id": "websub:UCForward:vid-1"' in captured["data"]


def test_youtube_websub_callback_post_fails_closed_when_forwarding_config_missing():
    app = create_app(
        environ={
            "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
            "CHANNEL_BOUNDARY_PROVIDER": "youtube",
            "CHANNEL_BOUNDARY_YOUTUBE_API_KEY": "data-api-key",
            "CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL": "https://boundary.example.test/v1/websub/callback",
        },
        http_client=FakeYouTubeHttpClient([]),
    )
    client = TestClient(app)

    response = client.post(
        "/v1/websub/callback",
        content=b'<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:channelId>UCForward</yt:channelId><yt:videoId>vid-1</yt:videoId></entry></feed>',
    )

    assert response.status_code == 503
    assert response.json() == {
        "ok": False,
        "error": {"code": "boundary_misconfigured", "message": "Local WebSub event forwarding is not configured", "retryable": True},
    }


def test_websub_callback_post_rejects_invalid_payload_without_forwarding():
    forwarder = RecordingForwarder()
    app = create_app(
        provider=FakeProvider(),
        event_forwarder=forwarder,
        environ={
            "CHANNEL_BOUNDARY_API_TOKEN": "secret-token",
            "CHANNEL_BOUNDARY_LOCAL_EVENT_URL": "https://local.example.test/api/monitor/boundary/websub-events",
            "CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY": "local-event-key",
        },
    )
    client = TestClient(app)

    response = client.post("/v1/websub/callback", content=b"<feed></feed>")

    assert response.status_code == 400
    assert response.json() == {
        "ok": False,
        "error": {"code": "invalid_websub_payload", "message": "WebSub callback did not include video ids", "retryable": False},
    }
    assert forwarder.calls == []


def test_boundary_mock_smoke_script_documents_health_metadata_and_outage_without_live_egress():
    script = (BOUNDARY_ROOT / "scripts" / "smoke-mock-boundary.ps1").read_text(encoding="utf-8")
    readme = (BOUNDARY_ROOT / "README.md").read_text(encoding="utf-8")

    assert "Mock-only smoke" in script
    assert "http://127.0.0.1:8088" in script
    assert "/health" in script
    assert "/v1/videos/metadata" in script
    assert "Authorization" in script
    assert "Bearer" in script
    assert "boundary outage" in script.casefold()
    assert "CHANNEL_BOUNDARY_API_TOKEN" in script
    assert "[redacted]" in script
    assert "Does not start the boundary service" in script
    assert "youtube.com" not in script.casefold()
    assert "googleapis" not in script.casefold()
    assert "googlevideo" not in script.casefold()
    assert "yt-dlp" not in script.casefold()
    assert "Boundary mock smoke" in readme
    assert "scripts\\smoke-mock-boundary.ps1" in readme
    assert "mock provider" in readme.casefold()
    assert "CHANNEL_BOUNDARY_PROVIDER=youtube" in readme
    assert "CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL" in readme
    assert "CHANNEL_BOUNDARY_LOCAL_EVENT_URL" in readme
    assert "Channel Monitor remains stopped" in readme
    assert "rollback" in readme.casefold()
    assert "does not print secrets" in readme.casefold()
    assert "Real WebSub rollout notes" in script
    assert "radar-channel-monitor" in script
    assert "CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL" in script


def test_cloud_deploy_script_requires_secret_manager_refs_and_preserves_operator_order():
    script = (BOUNDARY_ROOT / "scripts" / "deploy-cloud-run-boundary.ps1").read_text(encoding="utf-8")
    readme = (BOUNDARY_ROOT / "README.md").read_text(encoding="utf-8")

    assert "ConfirmDeploy" in script
    assert "-NoTraffic" in script
    assert "CHANNEL_BOUNDARY_PROVIDER=youtube" in script
    assert "CHANNEL_BOUNDARY_YOUTUBE_API_KEY=" in script
    assert "CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL=" in script
    assert "CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY=" in script
    assert "--set-secrets" in script
    assert "Secret Manager" in script
    assert "Refusing to deploy" in script
    assert "Do not pass raw token or API key values" in script
    assert "$env:CHANNEL_BOUNDARY_API_TOKEN" not in script
    assert "$env:CHANNEL_BOUNDARY_YOUTUBE_API_KEY" not in script
    assert "Write-Host $" not in script
    assert "Deploy boundary" in readme
    assert "Smoke cloud" in readme
    assert readme.index("Deploy boundary") < readme.index("Smoke cloud")
    assert readme.index("Smoke cloud") < readme.index("configure/restart `radar-channel-monitor`")


def test_cloud_smoke_script_checks_youtube_mode_without_printing_secrets_or_restarting_monitor():
    script = (BOUNDARY_ROOT / "scripts" / "smoke-cloud-boundary.ps1").read_text(encoding="utf-8")
    readme = (BOUNDARY_ROOT / "README.md").read_text(encoding="utf-8")

    assert "/health" in script
    assert '"provider"' in script
    assert '"youtube"' in script
    assert "/v1/channels/resolve" in script
    assert "/v1/videos/metadata" in script
    assert "/v1/playlists/uploads" in script
    assert "/v1/subtitles/fetch" in script
    assert "/v1/websub/renew" in script
    assert "CHANNEL_BOUNDARY_API_TOKEN is required" in script
    assert "Refusing cloud smoke" in script
    assert "[redacted]" in script
    assert "Restart-Service" not in script
    assert "gcloud run services update" not in script
    assert "$env:CHANNEL_BOUNDARY_API_TOKEN" not in script
    assert "$env:CHANNEL_BOUNDARY_YOUTUBE_API_KEY" not in script
    assert "metadata/uploads/subtitles/WebSub" in readme
    assert "Do not run this script from CI" in readme
    assert "does not restart services" in readme.casefold()


def test_boundary_powershell_scripts_keep_param_block_before_executable_statements():
    for script_path in sorted((BOUNDARY_ROOT / "scripts").glob("*.ps1")):
        lines = script_path.read_text(encoding="utf-8").splitlines()
        meaningful = [line.strip() for line in lines if line.strip() and not line.strip().startswith("#")]

        assert meaningful[0].startswith("param("), f"{script_path.name} must put param() before executable statements"
