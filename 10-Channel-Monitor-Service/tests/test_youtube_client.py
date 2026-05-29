from __future__ import annotations

import hmac

from app.youtube_client import (
    CallbackValidationError,
    ChannelMetadata,
    MetadataUnavailable,
    SubtitleUnavailable,
    TimedTextSubtitleProvider,
    SubtitleSegment,
    VideoMetadata,
    WebSubClient,
    YouTubeTranscriptSubtitleProvider,
    YouTubeDataClient,
    UploadItem,
    _extract_handle,
    parse_websub_video_ids,
    resolve_caption_language,
    validate_websub_callback,
)


class FakeTranscriptError(Exception):
    pass


def named_exception(name: str, message: str = "boom"):
    return type(name, (FakeTranscriptError,), {})(message)


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200, text: str | None = None):
        self._payload = payload
        self.status_code = status_code
        self.text = text if text is not None else str(payload)

    def json(self) -> dict:
        return self._payload


class FakeHttp:
    def __init__(self, response: FakeResponse | None = None):
        self.response = response or FakeResponse({})
        self.posts: list[tuple[str, dict]] = []

    def get(self, url: str, params: dict):
        self.last_get = (url, params)
        return self.response

    def post(self, url: str, data: dict, timeout: int):
        self.posts.append((url, data))
        return self.response


class SequenceHttp:
    def __init__(self, responses):
        self.responses = list(responses)
        self.gets = []

    def get(self, url: str, params: dict):
        self.gets.append((url, params))
        return self.responses.pop(0)

    def post(self, url: str, data: dict, timeout: int):
        raise AssertionError("unexpected post")

class FakeTimedTextHttp:
    def __init__(self, text: str):
        self.text = text
        self.calls: list[tuple[str, dict]] = []

    def get(self, url: str, params: dict):
        self.calls.append((url, params))
        return FakeResponse({}, text=self.text)


class FakeTranscript:
    def __init__(self, *, language_code: str, snippets: list[dict]):
        self.language_code = language_code
        self.snippets = snippets
        self.fetch_calls = 0

    def fetch(self):
        self.fetch_calls += 1
        return self.snippets


class FakeTranscriptList:
    def __init__(self, *, manual=None, generated=None, find_error=None):
        self.manual = manual
        self.generated = generated
        self.find_error = find_error or named_exception("NoTranscriptFound", "not found")
        self.manual_calls: list[list[str]] = []
        self.generated_calls: list[list[str]] = []

    def find_manually_created_transcript(self, languages):
        self.manual_calls.append(list(languages))
        if self.manual is None:
            raise self.find_error
        return self.manual

    def find_generated_transcript(self, languages):
        self.generated_calls.append(list(languages))
        if self.generated is None:
            raise self.find_error
        return self.generated


class FakeTranscriptApi:
    def __init__(self, transcript_list=None, error=None):
        self.transcript_list = transcript_list
        self.error = error
        self.calls: list[str] = []

    def list_transcripts(self, video_id: str):
        self.calls.append(video_id)
        if self.error is not None:
            raise self.error
        return self.transcript_list


def test_youtube_client_resolves_handle_and_video_metadata_with_injected_http():
    http = FakeHttp(
        FakeResponse(
            {
                "items": [
                    {
                        "id": "UCStable",
                        "snippet": {"title": "L'Équipe"},
                        "contentDetails": {"relatedPlaylists": {"uploads": "UUStable"}},
                    }
                ]
            }
        )
    )
    client = YouTubeDataClient(api_key="test-key", http=http)

    channel = client.resolve_channel("https://www.youtube.com/@lequipe")

    assert channel == ChannelMetadata(channel_id="UCStable", title="L'Équipe", uploads_playlist_id="UUStable")
    assert http.last_get[1]["forHandle"] == "lequipe"

    http.response = FakeResponse(
        {
            "items": [
                {
                    "id": "video-1",
                    "snippet": {"channelId": "UCStable", "title": "France reaction", "publishedAt": "2026-05-19T10:00:00Z"},
                    "liveStreamingDetails": {"actualEndTime": "2026-05-19T11:00:00Z"},
                }
            ]
        }
    )

    metadata = client.get_video_metadata("video-1")

    assert metadata == VideoMetadata(
        video_id="video-1",
        channel_id="UCStable",
        title="France reaction",
        published_at="2026-05-19T10:00:00Z",
        live_status="completed",
    )


def test_extract_handle_normalizes_handle_paths_without_suffix_query_or_fragment():
    assert [_extract_handle(source) for source in [
        "@club",
        "https://youtube.com/@club/videos",
        "youtube.com/@club/streams?view=2",
        "https://www.youtube.com/@club#featured",
    ]] == ["club", "club", "club", "club"]


def test_extract_handle_does_not_invent_handle_for_channel_or_watch_urls():
    assert _extract_handle("https://www.youtube.com/channel/UCStable") == ""
    assert _extract_handle("https://www.youtube.com/watch?v=abc123") == ""


def test_youtube_client_reports_metadata_unavailable_when_api_returns_no_items():
    client = YouTubeDataClient(api_key="test-key", http=FakeHttp(FakeResponse({"items": []})))

    try:
        client.get_video_metadata("missing")
    except MetadataUnavailable as exc:
        assert exc.video_id == "missing"
        assert "missing" in str(exc)
    else:
        raise AssertionError("expected MetadataUnavailable")


def test_youtube_client_lists_upload_playlist_video_ids_with_api_params_and_limit():
    http = FakeHttp(
        FakeResponse(
            {
                "items": [
                    {"contentDetails": {"videoId": "new-1"}},
                    {"contentDetails": {"videoId": "new-2"}},
                    {"contentDetails": {}},
                ]
            }
        )
    )
    client = YouTubeDataClient(api_key="test-key", http=http)

    video_ids = client.list_upload_video_ids("UUStable", limit=2)

    assert video_ids == ["new-1", "new-2"]
    assert http.last_get == (
        "https://www.googleapis.com/youtube/v3/playlistItems",
        {"part": "contentDetails", "playlistId": "UUStable", "maxResults": 2, "key": "test-key"},
    )


def test_youtube_client_iterates_upload_items_with_pagination_and_published_timestamps():
    http = SequenceHttp([
        FakeResponse({"nextPageToken": "page-2", "items": [{"contentDetails": {"videoId": "new-1", "videoPublishedAt": "2026-05-28T20:02:00Z"}}]}),
        FakeResponse({"items": [{"contentDetails": {"videoId": "new-2", "videoPublishedAt": "2026-05-28T20:01:00Z"}}]}),
    ])
    client = YouTubeDataClient(api_key="test-key", http=http)

    items = list(client.iter_upload_items("UUStable", page_limit=5, item_limit=10))

    assert items == [
        UploadItem(video_id="new-1", published_at="2026-05-28T20:02:00Z", page_token=None),
        UploadItem(video_id="new-2", published_at="2026-05-28T20:01:00Z", page_token="page-2"),
    ]
    assert http.gets[0][1] == {"part": "snippet,contentDetails", "playlistId": "UUStable", "maxResults": 50, "key": "test-key"}
    assert http.gets[1][1] == {"part": "snippet,contentDetails", "playlistId": "UUStable", "maxResults": 50, "key": "test-key", "pageToken": "page-2"}


def test_youtube_client_iter_upload_items_falls_back_to_snippet_timestamp_and_video_id():
    http = SequenceHttp([
        FakeResponse({"items": [{"snippet": {"publishedAt": "2026-05-28T20:02:00Z", "resourceId": {"videoId": "fallback-video"}}, "contentDetails": {}}]}),
    ])
    client = YouTubeDataClient(api_key="test-key", http=http)

    items = list(client.iter_upload_items("UUStable", page_limit=1, item_limit=10))

    assert items == [UploadItem(video_id="fallback-video", published_at="2026-05-28T20:02:00Z", page_token=None)]
    assert http.gets[0][1]["part"] == "snippet,contentDetails"


def test_websub_helpers_validate_secret_signature_parse_ids_and_subscribe():
    body = b"""<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>abc123</yt:videoId></entry></feed>"""
    signature = "sha256=" + hmac.new(b"callback-secret", body, "sha256").hexdigest()

    validate_websub_callback(body, {"x-hub-signature-256": signature}, "callback-secret")
    assert parse_websub_video_ids(body) == ["abc123"]

    http = FakeHttp(FakeResponse({}, status_code=202))
    client = WebSubClient(callback_url="https://monitor.test/api/monitor/websub", http=http)
    accepted = client.subscribe("UCStable", mode="subscribe", lease_seconds=3600)

    assert accepted is True
    assert http.posts[0][1]["hub.topic"] == "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCStable"

    try:
        validate_websub_callback(body, {"x-hub-signature-256": "sha256=bad"}, "callback-secret")
    except CallbackValidationError as exc:
        assert "signature" in str(exc)
    else:
        raise AssertionError("expected CallbackValidationError")


def test_timed_text_subtitle_provider_uses_source_language_and_parses_segments():
    xml = """<?xml version="1.0" encoding="utf-8" ?><transcript>
      <text start="1.5" dur="4.25">Ecuador &amp; Argentina played beautifully</text>
      <text start="6" dur="3">Great football tonight</text>
    </transcript>"""
    http = FakeTimedTextHttp(xml)
    provider = TimedTextSubtitleProvider(http=http)

    segments = provider.fetch(video_id="vid-1", source_language="es", default_language="en")

    assert segments == [
        SubtitleSegment(start_ms=1500, end_ms=5750, text="Ecuador & Argentina played beautifully", language="es"),
        SubtitleSegment(start_ms=6000, end_ms=9000, text="Great football tonight", language="es"),
    ]
    assert http.calls == [
        (
            "https://www.youtube.com/api/timedtext",
            {"v": "vid-1", "lang": "es", "fmt": "srv3"},
        )
    ]


def test_caption_language_resolution_maps_source_countries_to_timed_text_codes():
    cases = {
        "argentina": "es",
        "méxico": "es",
        "colombia": "es",
        "france": "fr",
        "fr": "fr",
        "england": "en",
        "usa": "en",
        "italy": "it",
        "brazil": "pt",
    }

    for source_country, expected_language in cases.items():
        resolution = resolve_caption_language(source_country=source_country, default_language="en")
        assert resolution.language == expected_language
        assert resolution.fallback_used is False
        assert resolution.source_country == source_country


def test_caption_language_resolution_records_unknown_country_fallback_without_erasing_source_country():
    resolution = resolve_caption_language(source_country="japan", default_language="en")

    assert resolution.language == "en"
    assert resolution.fallback_used is True
    assert resolution.source_country == "japan"
    assert resolution.reason == "unknown-source-country"


def test_timed_text_subtitle_provider_falls_back_to_default_language_and_reports_missing_segments():
    http = FakeTimedTextHttp("<transcript></transcript>")
    provider = TimedTextSubtitleProvider(http=http)

    try:
        provider.fetch(video_id="vid-2", source_language=None, default_language="en")
    except SubtitleUnavailable as exc:
        assert exc.video_id == "vid-2"
        assert exc.language == "en"
    else:
        raise AssertionError("expected SubtitleUnavailable")

    assert http.calls[0][1] == {"v": "vid-2", "lang": "en", "fmt": "srv3"}


def test_timed_text_subtitle_provider_uses_country_resolution_instead_of_country_names():
    xml = """<transcript><text start="0" dur="3">Bom futebol</text></transcript>"""
    http = FakeTimedTextHttp(xml)
    provider = TimedTextSubtitleProvider(http=http)

    segments = provider.fetch(video_id="vid-br", source_language="brazil", default_language="en")

    assert segments == [SubtitleSegment(start_ms=0, end_ms=3000, text="Bom futebol", language="pt")]
    assert http.calls == [
        (
            "https://www.youtube.com/api/timedtext",
            {"v": "vid-br", "lang": "pt", "fmt": "srv3"},
        )
    ]


def test_youtube_transcript_provider_prefers_manual_source_language_and_marks_actual_language():
    transcript = FakeTranscript(
        language_code="es",
        snippets=[{"start": 1.25, "duration": 2.5, "text": "Ecuador y Argentina jugaron hermoso fútbol"}],
    )
    transcript_list = FakeTranscriptList(manual=transcript)
    provider = YouTubeTranscriptSubtitleProvider(api=FakeTranscriptApi(transcript_list=transcript_list))

    segments = provider.fetch(video_id="vid-1", source_language="argentina", default_language="en")

    assert segments == [
        SubtitleSegment(
            start_ms=1250,
            end_ms=3750,
            text="Ecuador y Argentina jugaron hermoso fútbol",
            language="es",
        )
    ]
    assert transcript_list.manual_calls == [["es", "en"]]
    assert transcript_list.generated_calls == []


def test_youtube_transcript_provider_falls_back_to_generated_default_language_when_source_unavailable():
    transcript = FakeTranscript(
        language_code="en",
        snippets=[{"start": 10, "duration": 3, "text": "Argentina played great football"}],
    )
    transcript_list = FakeTranscriptList(manual=None, generated=transcript)
    provider = YouTubeTranscriptSubtitleProvider(api=FakeTranscriptApi(transcript_list=transcript_list))

    segments = provider.fetch(video_id="vid-2", source_language="brazil", default_language="en")

    assert segments == [SubtitleSegment(start_ms=10000, end_ms=13000, text="Argentina played great football", language="en")]
    assert transcript_list.manual_calls == [["pt", "en"]]
    assert transcript_list.generated_calls == [["pt", "en"]]


def test_youtube_transcript_provider_reports_language_unavailable_with_details():
    provider = YouTubeTranscriptSubtitleProvider(
        api=FakeTranscriptApi(transcript_list=FakeTranscriptList(find_error=named_exception("NoTranscriptFound", "no requested language")))
    )

    try:
        provider.fetch(video_id="vid-3", source_language="italy", default_language="en")
    except SubtitleUnavailable as exc:
        assert exc.video_id == "vid-3"
        assert exc.language == "it"
        assert exc.reason == "language_unavailable"
        assert exc.details == {
            "provider": "youtube-transcript-api",
            "reason": "language_unavailable",
            "video_id": "vid-3",
            "requested_languages": ["it", "en"],
            "source_language": "italy",
            "default_language": "en",
            "resolution_reason": "mapped-source-country",
            "fallback_used": False,
            "error_type": "NoTranscriptFound",
            "error": "no requested language",
        }
        assert "language_unavailable" in str(exc)
    else:
        raise AssertionError("expected SubtitleUnavailable")


def test_youtube_transcript_provider_maps_transcript_api_errors_to_observable_reasons():
    cases = {
        "TranscriptsDisabled": "transcripts_disabled",
        "VideoUnavailable": "video_unavailable",
        "NoTranscriptAvailable": "no_transcript",
        "RequestBlocked": "fetch_error",
    }

    for error_name, expected_reason in cases.items():
        provider = YouTubeTranscriptSubtitleProvider(api=FakeTranscriptApi(error=named_exception(error_name, error_name)))
        try:
            provider.fetch(video_id="vid-error", source_language="france", default_language="en")
        except SubtitleUnavailable as exc:
            assert exc.reason == expected_reason
            assert exc.details["error_type"] == error_name
            assert exc.details["provider"] == "youtube-transcript-api"
        else:
            raise AssertionError(f"expected SubtitleUnavailable for {error_name}")


def test_youtube_transcript_provider_reports_empty_transcript_and_missing_dependency():
    empty_provider = YouTubeTranscriptSubtitleProvider(
        api=FakeTranscriptApi(transcript_list=FakeTranscriptList(manual=FakeTranscript(language_code="es", snippets=[])))
    )
    try:
        empty_provider.fetch(video_id="empty", source_language="es", default_language="en")
    except SubtitleUnavailable as exc:
        assert exc.reason == "empty_transcript"
        assert exc.details["actual_language"] == "es"
    else:
        raise AssertionError("expected empty transcript failure")

    missing_provider = YouTubeTranscriptSubtitleProvider(api_factory=lambda: (_ for _ in ()).throw(ImportError("missing dep")))
    try:
        missing_provider.fetch(video_id="missing-dep", source_language="es", default_language="en")
    except SubtitleUnavailable as exc:
        assert exc.reason == "dependency_missing"
        assert exc.details["error_type"] == "ImportError"
    else:
        raise AssertionError("expected dependency missing failure")
