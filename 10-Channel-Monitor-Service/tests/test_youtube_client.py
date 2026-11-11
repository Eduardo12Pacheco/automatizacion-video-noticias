from __future__ import annotations

import hmac
import json

from app.youtube_client import (
    CallbackValidationError,
    ChannelMetadata,
    CompositeSubtitleProvider,
    MetadataUnavailable,
    PolicyForbiddenLocalYouTube,
    SubtitleUnavailable,
    TimedTextSubtitleProvider,
    SubtitleSegment,
    VideoMetadata,
    WebSubClient,
    YouTubeTranscriptSubtitleProvider,
    YtDlpSubtitleProvider,
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
    def __init__(self, *, language_code: str, snippets: list[dict], is_generated: bool = False, is_translated: bool = False):
        self.language_code = language_code
        self.snippets = snippets
        self.is_generated = is_generated
        self.is_translated = is_translated
        self.fetch_calls = 0

    def fetch(self):
        self.fetch_calls += 1
        return self.snippets


class FakeTranscriptList:
    def __init__(self, *, manual=None, generated=None, transcripts=None, find_error=None, list_error=None):
        self.manual = manual
        self.generated = generated
        self.transcripts = transcripts
        self.find_error = find_error or named_exception("NoTranscriptFound", "not found")
        self.list_error = list_error
        self.manual_calls: list[list[str]] = []
        self.generated_calls: list[list[str]] = []

    def __iter__(self):
        if self.list_error is not None:
            raise self.list_error
        if self.transcripts is not None:
            return iter(self.transcripts)
        return iter([transcript for transcript in (self.manual, self.generated) if transcript is not None])

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


class FakeRunResult:
    def __init__(self, *, stdout: str = "", stderr: str = "", returncode: int = 0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


class FakePrimarySubtitleProvider:
    def __init__(self, value):
        self.value = value
        self.calls = []

    def fetch(self, *, video_id: str, source_language: str | None, default_language: str):
        self.calls.append((video_id, source_language, default_language))
        if isinstance(self.value, Exception):
            raise self.value
        return self.value


class FakeYtDlpRunner:
    def __init__(self, *, info: dict | None = None, subtitle_text: str = "", subtitle_suffix: str = "vtt", error: str | None = None):
        self.info = info or {}
        self.subtitle_text = subtitle_text
        self.subtitle_suffix = subtitle_suffix
        self.error = error
        self.calls = []

    def __call__(self, args, cwd):
        self.calls.append((list(args), cwd))
        if self.error:
            return FakeRunResult(stderr=self.error, returncode=1)
        if "--dump-json" in args:
            return FakeRunResult(stdout=json.dumps(self.info))
        (cwd / f"vid-yt.es.{self.subtitle_suffix}").write_text(self.subtitle_text, encoding="utf-8")
        return FakeRunResult()


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


def test_local_youtube_provider_construction_is_forbidden_in_protected_mode():
    constructors = [
        lambda: YouTubeDataClient(api_key="test-key", network_mode="protected"),
        lambda: YouTubeTranscriptSubtitleProvider(network_mode="protected"),
        lambda: YtDlpSubtitleProvider(network_mode="protected"),
        lambda: WebSubClient(callback_url="https://monitor.test/api/monitor/websub", network_mode="protected"),
    ]

    errors = []
    for constructor in constructors:
        try:
            constructor()
        except PolicyForbiddenLocalYouTube as exc:
            errors.append(str(exc))
        else:
            raise AssertionError("protected mode must forbid local YouTube provider construction")

    assert errors == [
        "policy_forbidden_local_youtube",
        "policy_forbidden_local_youtube",
        "policy_forbidden_local_youtube",
        "policy_forbidden_local_youtube",
    ]


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
    assert transcript_list.manual_calls == []
    assert transcript_list.generated_calls == []


def test_youtube_transcript_provider_chooses_original_french_transcript_over_country_language():
    translated = FakeTranscript(
        language_code="es",
        snippets=[{"start": 0, "duration": 3, "text": "Traduccion al espanol"}],
        is_translated=True,
    )
    original = FakeTranscript(
        language_code="fr",
        snippets=[{"start": 0, "duration": 3, "text": "La France a bien joue"}],
    )
    transcript_list = FakeTranscriptList(transcripts=[translated, original])
    provider = YouTubeTranscriptSubtitleProvider(api=FakeTranscriptApi(transcript_list=transcript_list))

    segments = provider.fetch(video_id="vid-fr", source_language="colombia", default_language="en")

    assert segments == [SubtitleSegment(start_ms=0, end_ms=3000, text="La France a bien joue", language="fr")]
    assert original.fetch_calls == 1
    assert translated.fetch_calls == 0
    assert transcript_list.manual_calls == []
    assert transcript_list.generated_calls == []


def test_youtube_transcript_provider_chooses_generated_original_when_no_manual_exists():
    generated = FakeTranscript(
        language_code="fr",
        snippets=[{"start": 4, "duration": 2, "text": "Sous-titres generes"}],
        is_generated=True,
    )
    transcript_list = FakeTranscriptList(transcripts=[generated])
    provider = YouTubeTranscriptSubtitleProvider(api=FakeTranscriptApi(transcript_list=transcript_list))

    segments = provider.fetch(video_id="vid-generated-fr", source_language="argentina", default_language="en")

    assert segments == [SubtitleSegment(start_ms=4000, end_ms=6000, text="Sous-titres generes", language="fr")]
    assert generated.fetch_calls == 1
    assert transcript_list.manual_calls == []
    assert transcript_list.generated_calls == []


def test_youtube_transcript_provider_uses_generated_original_default_language_when_source_unavailable():
    transcript = FakeTranscript(
        language_code="en",
        snippets=[{"start": 10, "duration": 3, "text": "Argentina played great football"}],
        is_generated=True,
    )
    transcript_list = FakeTranscriptList(manual=None, generated=transcript)
    provider = YouTubeTranscriptSubtitleProvider(api=FakeTranscriptApi(transcript_list=transcript_list))

    segments = provider.fetch(video_id="vid-2", source_language="brazil", default_language="en")

    assert segments == [SubtitleSegment(start_ms=10000, end_ms=13000, text="Argentina played great football", language="en")]
    assert transcript_list.manual_calls == []
    assert transcript_list.generated_calls == []


def test_youtube_transcript_provider_falls_back_to_language_finders_when_listing_transcripts_fails():
    transcript = FakeTranscript(
        language_code="es",
        snippets=[{"start": 1, "duration": 2, "text": "Ecuador jugo bien"}],
    )
    transcript_list = FakeTranscriptList(manual=transcript, list_error=TypeError("not iterable"))
    provider = YouTubeTranscriptSubtitleProvider(api=FakeTranscriptApi(transcript_list=transcript_list))

    segments = provider.fetch(video_id="vid-list-fallback", source_language="argentina", default_language="en")

    assert segments == [SubtitleSegment(start_ms=1000, end_ms=3000, text="Ecuador jugo bien", language="es")]
    assert transcript_list.manual_calls == [["es", "en"]]
    assert transcript_list.generated_calls == []


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


def test_composite_subtitle_provider_primary_success_does_not_call_yt_dlp():
    primary = FakePrimarySubtitleProvider([SubtitleSegment(0, 1000, "primary", "es")])
    fallback = FakePrimarySubtitleProvider([SubtitleSegment(0, 1000, "fallback", "es")])
    provider = CompositeSubtitleProvider(primary=primary, fallback=fallback)

    segments = provider.fetch(video_id="vid-ok", source_language="argentina", default_language="en")

    assert segments == [SubtitleSegment(0, 1000, "primary", "es")]
    assert primary.calls == [("vid-ok", "argentina", "en")]
    assert fallback.calls == []


def test_composite_subtitle_provider_primary_failure_triggers_yt_dlp_with_cookies_and_skip_download(tmp_path):
    cookies = tmp_path / "cookies.txt"
    cookies.write_text("cookie data is not inspected", encoding="utf-8")
    runner = FakeYtDlpRunner(
        info={"subtitles": {"es": [{"ext": "vtt", "name": "Spanish"}]}},
        subtitle_text="""WEBVTT

00:00:01.000 --> 00:00:03.500
Ecuador jugo bien
""",
    )
    provider = CompositeSubtitleProvider(
        primary=FakePrimarySubtitleProvider(SubtitleUnavailable("vid-yt", "es")),
        fallback=YtDlpSubtitleProvider(binary="yt-dlp-test", cookies_path=cookies, runner=runner),
    )

    segments = provider.fetch(video_id="vid-yt", source_language="argentina", default_language="en")

    assert segments == [SubtitleSegment(1000, 3500, "Ecuador jugo bien", "es")]
    assert len(runner.calls) == 2
    for args, _cwd in runner.calls:
        assert args[0] == "yt-dlp-test"
        assert "--skip-download" in args
        assert "--cookies" in args
        assert str(cookies) in args
    assert "--dump-json" in runner.calls[0][0]
    assert "--write-subs" in runner.calls[1][0]
    assert "--write-auto-subs" not in runner.calls[1][0]


def test_yt_dlp_subtitle_provider_parses_sample_vtt_into_segments():
    runner = FakeYtDlpRunner(
        info={"subtitles": {"es": [{"ext": "vtt", "name": "Spanish"}]}},
        subtitle_text="""WEBVTT

1
00:00:01.250 --> 00:00:04.000 align:start position:0%
<c>Argentina &amp; Ecuador</c>
jugaron excelente futbol

00:00:05.000 --> 00:00:06.000
Otro segmento
""",
    )
    provider = YtDlpSubtitleProvider(runner=runner)

    segments = provider.fetch(video_id="vid-yt", source_language="es", default_language="en")

    assert segments == [
        SubtitleSegment(1250, 4000, "Argentina & Ecuador jugaron excelente futbol", "es"),
        SubtitleSegment(5000, 6000, "Otro segmento", "es"),
    ]


def test_yt_dlp_subtitle_provider_preserves_no_subtitles_handling():
    provider = YtDlpSubtitleProvider(runner=FakeYtDlpRunner(info={"subtitles": {}, "automatic_captions": {}}))

    try:
        provider.fetch(video_id="missing", source_language="es", default_language="en")
    except SubtitleUnavailable as exc:
        assert exc.video_id == "missing"
        assert exc.reason == "no_subtitles"
        assert exc.details["provider"] == "yt-dlp-subtitles"
    else:
        raise AssertionError("expected SubtitleUnavailable")


def test_yt_dlp_subtitle_provider_prefers_native_manual_before_translated_or_auto():
    runner = FakeYtDlpRunner(
        info={
            "language": "fr",
            "subtitles": {
                "es": [{"ext": "vtt", "name": "Spanish translated from French"}],
                "fr": [{"ext": "vtt", "name": "French"}],
            },
            "automatic_captions": {"fr": [{"ext": "vtt", "name": "French automatic"}]},
        },
        subtitle_text="""WEBVTT

00:00:00.000 --> 00:00:02.000
La France a bien joue
""",
    )

    segments = YtDlpSubtitleProvider(runner=runner).fetch(video_id="vid-yt", source_language="argentina", default_language="en")

    assert segments == [SubtitleSegment(0, 2000, "La France a bien joue", "fr")]
    download_args = runner.calls[1][0]
    assert download_args[download_args.index("--sub-langs") + 1] == "fr"
    assert "--write-subs" in download_args
