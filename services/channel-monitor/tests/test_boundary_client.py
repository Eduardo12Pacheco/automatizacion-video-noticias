from __future__ import annotations

from app.boundary_client import (
    BoundaryEnvelope,
    BoundaryError,
    BoundaryMetadataUnavailable,
    BoundaryRequestError,
    BoundaryRequest,
    ChannelNetworkBoundaryClient,
    ChannelResolveRequest,
    SubtitleFetchRequest,
    UploadsPlaylistRequest,
    VideoMetadataRequest,
)
from app.youtube_client import SubtitleUnavailable


class FakeBoundaryHttp:
    def __init__(self, responses=None, error=None):
        self.responses = responses or {}
        self.error = error
        self.calls = []

    def post_json(self, url, *, payload, headers, timeout):
        self.calls.append({"url": url, "payload": payload, "headers": headers, "timeout": timeout})
        if self.error is not None:
            raise self.error
        return self.responses[url.rsplit("/v1", 1)[1] if "/v1" in url else url]


def test_boundary_success_envelope_exposes_data_without_error():
    envelope = BoundaryEnvelope.from_payload({"ok": True, "data": {"video_id": "vid-1", "title": "Match"}})

    assert envelope.ok is True
    assert envelope.data == {"video_id": "vid-1", "title": "Match"}
    assert envelope.error is None


def test_boundary_error_envelope_exposes_typed_error_and_retryable_flag():
    envelope = BoundaryEnvelope.from_payload(
        {"ok": False, "error": {"code": "boundary_unreachable", "message": "try later", "retryable": True}}
    )

    assert envelope.ok is False
    assert envelope.data is None
    assert envelope.error == BoundaryError(code="boundary_unreachable", message="try later", retryable=True)


def test_boundary_request_dtos_match_expected_endpoint_payload_contracts():
    requests: list[BoundaryRequest] = [
        ChannelResolveRequest(source="https://youtube.com/@club"),
        VideoMetadataRequest(video_id="vid-1"),
        UploadsPlaylistRequest(uploads_playlist_id="UUStable", page_limit=2, item_limit=25),
        SubtitleFetchRequest(video_id="vid-sub", source_language="valdoria", default_language="en"),
    ]

    assert [(request.endpoint, request.payload()) for request in requests] == [
        ("/v1/channels/resolve", {"source": "https://youtube.com/@club"}),
        ("/v1/videos/metadata", {"video_id": "vid-1"}),
        ("/v1/playlists/uploads", {"uploads_playlist_id": "UUStable", "page_limit": 2, "item_limit": 25}),
        (
            "/v1/subtitles/fetch",
            {"video_id": "vid-sub", "source_language": "valdoria", "default_language": "en"},
        ),
    ]


def test_boundary_request_dtos_omit_optional_null_values_and_normalize_limits():
    uploads = UploadsPlaylistRequest(uploads_playlist_id="UUStable", page_limit=0, item_limit=-5)
    subtitles = SubtitleFetchRequest(video_id="vid-sub", source_language=None, default_language="")

    assert uploads.payload() == {"uploads_playlist_id": "UUStable", "page_limit": 1, "item_limit": 1}
    assert subtitles.payload() == {"video_id": "vid-sub", "default_language": "en"}


def test_boundary_client_posts_authenticated_requests_and_maps_successful_results():
    http = FakeBoundaryHttp(
        {
            "/channels/resolve": {"ok": True, "data": {"channel_id": "UCResolved", "title": "Club", "uploads_playlist_id": "UUResolved"}},
            "/videos/metadata": {"ok": True, "data": {"video_id": "vid-1", "channel_id": "UCResolved", "title": "Match", "published_at": "2026-06-01T00:00:00Z", "live_status": "none"}},
            "/playlists/uploads": {"ok": True, "data": {"items": [{"video_id": "vid-1", "published_at": "2026-06-01T00:00:00Z", "page_token": "p1"}, {"video_id": "vid-2", "published_at": None}]}},
            "/subtitles/fetch": {"ok": True, "data": {"segments": [{"start_ms": 0, "end_ms": 1250, "text": "gol", "language": "es"}]}},
        }
    )
    client = ChannelNetworkBoundaryClient(base_url="https://boundary.example.test/", token="secret-token", http=http)

    channel = client.resolve_channel("https://youtube.com/@club")
    metadata = client.get_video_metadata("vid-1")
    upload_items = list(client.iter_upload_items("UUResolved", page_limit=2, item_limit=50))
    upload_ids = client.list_upload_video_ids("UUResolved", limit=5)
    subtitles = client.fetch(video_id="vid-1", source_language="valdoria", default_language="en")

    assert (channel.channel_id, channel.title, channel.uploads_playlist_id) == ("UCResolved", "Club", "UUResolved")
    assert (metadata.video_id, metadata.channel_id, metadata.title, metadata.live_status) == ("vid-1", "UCResolved", "Match", "none")
    assert [(item.video_id, item.published_at, item.page_token) for item in upload_items] == [("vid-1", "2026-06-01T00:00:00Z", "p1"), ("vid-2", None, None)]
    assert upload_ids == ["vid-1", "vid-2"]
    assert [(segment.start_ms, segment.end_ms, segment.text, segment.language) for segment in subtitles] == [(0, 1250, "gol", "es")]
    assert http.calls[0]["headers"] == {"Authorization": "Bearer secret-token", "Content-Type": "application/json"}
    assert http.calls[0]["url"] == "https://boundary.example.test/v1/channels/resolve"


def test_boundary_client_fails_closed_for_unauthorized_and_outage_without_local_fallback():
    unauthorized = ChannelNetworkBoundaryClient(
        base_url="https://boundary.example.test",
        token="secret-token",
        http=FakeBoundaryHttp({"/videos/metadata": {"ok": False, "error": {"code": "unauthorized", "message": "no", "retryable": False}}}),
    )
    outage = ChannelNetworkBoundaryClient(
        base_url="https://boundary.example.test",
        token="secret-token",
        http=FakeBoundaryHttp(error=OSError("connection refused")),
    )

    try:
        unauthorized.get_video_metadata("vid-private")
    except BoundaryMetadataUnavailable as exc:
        unauthorized_error = exc
    else:
        raise AssertionError("expected boundary metadata failure")
    try:
        outage.resolve_channel("https://youtube.com/@club")
    except BoundaryRequestError as exc:
        outage_error = exc
    else:
        raise AssertionError("expected boundary outage failure")

    assert unauthorized_error.reason == "unauthorized"
    assert unauthorized_error.retryable is False
    assert outage_error.code == "boundary_unreachable"
    assert outage_error.retryable is True


def test_boundary_client_maps_subtitle_boundary_errors_to_retryable_subtitle_unavailable():
    client = ChannelNetworkBoundaryClient(
        base_url="https://boundary.example.test",
        token="secret-token",
        http=FakeBoundaryHttp({"/subtitles/fetch": {"ok": False, "error": {"code": "boundary_upstream_failed", "message": "upstream down", "retryable": True}}}),
    )

    try:
        client.fetch(video_id="vid-sub", source_language="valdoria", default_language="en")
    except SubtitleUnavailable as exc:
        error = exc
    else:
        raise AssertionError("expected subtitle failure")

    assert error.reason == "boundary_upstream_failed"
    assert error.details == {"provider": "channel-network-boundary", "retryable": True, "error_code": "boundary_upstream_failed"}
