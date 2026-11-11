from __future__ import annotations

from pathlib import Path
import subprocess

import pytest

from app.audio import FfmpegAudioExtractor
from app.downloader import RemoteFetcherDownloader, YtDlpDownloader, validate_media_url
from app.main import create_downloader
from app.models import TranscriptSegment
from app.settings import DEFAULT_YT_DLP_COOKIES_PATH
from app.settings import Settings
from app.settings import load_settings
from app.transcriber import FasterWhisperTranscriber
from app.worker import DependencyFailure


class Completed:
    returncode = 0
    stderr = ""
    stdout = "Argentina vs Colombia Highlights\n"


def test_yt_dlp_downloader_invokes_injected_runner_and_returns_downloaded_file(tmp_path):
    calls: list[list[str]] = []

    def runner(command: list[str]):
        calls.append(command)
        if "--output" in command:
            output = Path(command[command.index("--output") + 1])
            downloaded = output.with_name("source.mp4")
            downloaded.write_text("video", encoding="utf-8")
        return Completed()

    result = YtDlpDownloader(binary="yt-dlp", runner=runner, resolve_media_host=False).download("https://www.youtube.com/watch?v=abc", tmp_path)

    assert result.path == tmp_path / "source.mp4"
    assert result.title == "Argentina vs Colombia Highlights"
    assert calls == [
        ["yt-dlp", "--no-playlist", "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3", "--skip-download", "--print", "title", "https://www.youtube.com/watch?v=abc"],
        ["yt-dlp", "--no-playlist", "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3", "--max-filesize", "2G", "--match-filter", "duration <= 7200", "--format", "bestaudio/best", "--output", str(tmp_path / "source.%(ext)s"), "https://www.youtube.com/watch?v=abc"],
    ]


def test_yt_dlp_downloader_does_not_treat_title_print_as_download(tmp_path):
    calls: list[list[str]] = []

    def runner(command: list[str]):
        calls.append(command)
        return Completed()

    with pytest.raises(DependencyFailure) as failure:
        YtDlpDownloader(binary="yt-dlp", runner=runner, resolve_media_host=False).download("https://www.youtube.com/watch?v=abc", tmp_path)

    assert failure.value.code == "yt_dlp_no_output"
    assert len(calls) == 2
    assert "--skip-download" in calls[0]
    assert "--output" in calls[1]
    assert not list(tmp_path.glob("source.*"))


def test_yt_dlp_downloader_reports_typed_failure_when_binary_is_missing(tmp_path):
    def runner(command: list[str]):
        raise FileNotFoundError(command[0])

    with pytest.raises(DependencyFailure) as failure:
        YtDlpDownloader(binary="missing-yt-dlp", runner=runner, resolve_media_host=False).download("https://youtu.be/abc", tmp_path)

    assert failure.value.code == "yt_dlp_unavailable"
    assert "missing-yt-dlp" in failure.value.message


def test_yt_dlp_downloader_rejects_unsafe_url_before_subprocess(tmp_path):
    calls: list[list[str]] = []

    def runner(command: list[str], **kwargs):
        calls.append(command)
        return Completed()

    with pytest.raises(DependencyFailure) as failure:
        YtDlpDownloader(binary="yt-dlp", runner=runner).download("http://127.0.0.1/private", tmp_path)

    assert failure.value.code == "invalid_url"
    assert failure.value.message == "URL host is not allowed"
    assert calls == []


def test_validate_media_url_accepts_only_youtube_hosts_without_dns_lookup():
    validate_media_url("https://www.youtube.com/watch?v=abc", resolve_host=False)
    validate_media_url("https://youtube.com/shorts/abc", resolve_host=False)
    validate_media_url("https://youtu.be/abc", resolve_host=False)

    with pytest.raises(DependencyFailure) as failure:
        validate_media_url("https://video.example/watch?v=abc", resolve_host=False)

    assert failure.value.code == "invalid_url"
    assert failure.value.message == "URL host is not allowed"


def test_validate_media_url_rejects_youtube_host_when_dns_resolves_to_private_ip():
    def resolver(host: str) -> list[str]:
        assert host == "www.youtube.com"
        return ["10.0.0.12", "93.184.216.34"]

    with pytest.raises(DependencyFailure) as failure:
        validate_media_url("https://www.youtube.com/watch?v=abc", resolver=resolver)

    assert failure.value.code == "invalid_url"
    assert failure.value.message == "URL host resolves to a blocked address"


def test_validate_media_url_accepts_youtube_host_when_dns_resolves_publicly():
    validate_media_url("https://youtu.be/abc", resolver=lambda host: ["8.8.8.8"])


def test_yt_dlp_downloader_reports_timeout_as_typed_failure(tmp_path):
    def runner(command: list[str], **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    with pytest.raises(DependencyFailure) as failure:
        YtDlpDownloader(binary="yt-dlp", runner=runner, timeout_seconds=3, resolve_media_host=False).download("https://youtu.be/abc", tmp_path)

    assert failure.value.code == "yt_dlp_timeout"
    assert failure.value.message == "yt-dlp timed out after 3 seconds"


def test_yt_dlp_downloader_adds_existing_cookies_file_to_title_and_download_commands(tmp_path):
    cookies = tmp_path / "youtube-cookies.txt"
    cookies.write_text("cookie-placeholder", encoding="utf-8")
    calls: list[list[str]] = []

    def runner(command: list[str]):
        calls.append(command)
        if "--output" in command:
            output = Path(command[command.index("--output") + 1])
            output.with_name("source.webm").write_text("video", encoding="utf-8")
        return Completed()

    YtDlpDownloader(binary="yt-dlp", runner=runner, cookies_path=cookies, resolve_media_host=False).download("https://www.youtube.com/watch?v=abc", tmp_path)

    assert [command[command.index("--cookies") + 1] for command in calls] == [str(cookies), str(cookies)]


def test_yt_dlp_downloader_skips_missing_cookies_file(tmp_path):
    calls: list[list[str]] = []

    def runner(command: list[str]):
        calls.append(command)
        if "--output" in command:
            output = Path(command[command.index("--output") + 1])
            output.with_name("source.webm").write_text("video", encoding="utf-8")
        return Completed()

    YtDlpDownloader(binary="yt-dlp", runner=runner, cookies_path=tmp_path / "missing.txt", resolve_media_host=False).download("https://www.youtube.com/watch?v=abc", tmp_path)

    assert all("--cookies" not in command for command in calls)


def test_yt_dlp_downloader_adds_configured_js_runtime(tmp_path):
    calls: list[list[str]] = []

    def runner(command: list[str]):
        calls.append(command)
        if "--output" in command:
            output = Path(command[command.index("--output") + 1])
            output.with_name("source.webm").write_text("video", encoding="utf-8")
        return Completed()

    YtDlpDownloader(binary="yt-dlp", runner=runner, js_runtime="node", resolve_media_host=False).download("https://www.youtube.com/watch?v=abc", tmp_path)

    assert [command[command.index("--js-runtimes") + 1] for command in calls] == ["node", "node"]


def test_yt_dlp_downloader_classifies_bot_check_and_geo_block_errors(tmp_path):
    class BotCheck:
        returncode = 1
        stderr = "ERROR: Sign in to confirm you are not a bot"
        stdout = ""

    with pytest.raises(DependencyFailure) as bot_failure:
        YtDlpDownloader(binary="yt-dlp", runner=lambda command: BotCheck(), resolve_media_host=False).download("https://youtu.be/abc", tmp_path)

    assert bot_failure.value.code == "yt_dlp_bot_check"

    class GeoBlocked:
        returncode = 1
        stderr = "ERROR: This video is not available in your country"
        stdout = ""

    with pytest.raises(DependencyFailure) as geo_failure:
        YtDlpDownloader(binary="yt-dlp", runner=lambda command: GeoBlocked(), resolve_media_host=False).download("https://youtu.be/abc", tmp_path)

    assert geo_failure.value.code == "yt_dlp_geo_blocked"

    class CountryUnavailable:
        returncode = 1
        stderr = "ERROR: The uploader has not made this video available in your country"
        stdout = ""

    with pytest.raises(DependencyFailure) as country_failure:
        YtDlpDownloader(binary="yt-dlp", runner=lambda command: CountryUnavailable(), resolve_media_host=False).download("https://youtu.be/abc", tmp_path)

    assert country_failure.value.code == "yt_dlp_geo_blocked"


def test_yt_dlp_downloader_classifies_live_copyright_unavailable_and_age_restricted_errors(tmp_path):
    cases = [
        ("ERROR: This live event will begin in a few moments", "yt_dlp_live_pending"),
        ("ERROR: This video is not available because it contains content from FIFA, who has blocked it on copyright grounds", "yt_dlp_copyright_blocked"),
        ("ERROR: Video unavailable. This video is private", "yt_dlp_private_or_removed"),
        ("ERROR: This video has been removed by the uploader", "yt_dlp_private_or_removed"),
        ("ERROR: Sign in to confirm your age. This video may be inappropriate for some users", "yt_dlp_age_restricted"),
    ]

    for stderr, expected_code in cases:
        class Failed:
            returncode = 1
            stdout = ""

        Failed.stderr = stderr

        with pytest.raises(DependencyFailure) as failure:
            YtDlpDownloader(binary="yt-dlp", runner=lambda command: Failed(), resolve_media_host=False).download("https://youtu.be/abc", tmp_path)

        assert failure.value.code == expected_code


def test_ffmpeg_audio_extractor_creates_required_16khz_wav_contract(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_text("video", encoding="utf-8")
    calls: list[list[str]] = []

    def runner(command: list[str]):
        calls.append(command)
        Path(command[-1]).write_text("wav", encoding="utf-8")
        return Completed()

    result = FfmpegAudioExtractor(binary="ffmpeg", runner=runner).extract_16khz_wav(source, tmp_path / "audio")

    assert result == tmp_path / "audio" / "audio-16khz.wav"
    assert calls == [["ffmpeg", "-y", "-i", str(source), "-ac", "1", "-ar", "16000", str(result)]]


def test_ffmpeg_audio_extractor_reports_typed_failure_when_command_fails(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_text("video", encoding="utf-8")

    class Failed:
        returncode = 1
        stderr = "unsupported input"

    def runner(command: list[str]):
        return Failed()

    with pytest.raises(DependencyFailure) as failure:
        FfmpegAudioExtractor(binary="ffmpeg", runner=runner).extract_16khz_wav(source, tmp_path / "audio")

    assert failure.value.code == "ffmpeg_failed"
    assert failure.value.message == "unsupported input"


def test_ffmpeg_audio_extractor_reports_timeout_as_typed_failure(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_text("video", encoding="utf-8")

    def runner(command: list[str], **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    with pytest.raises(DependencyFailure) as failure:
        FfmpegAudioExtractor(binary="ffmpeg", runner=runner, timeout_seconds=2).extract_16khz_wav(source, tmp_path / "audio")

    assert failure.value.code == "ffmpeg_timeout"
    assert failure.value.message == "ffmpeg timed out after 2 seconds"


def test_faster_whisper_transcriber_uses_model_settings_and_maps_segments():
    created: dict[str, str] = {}

    class FakeSegment:
        def __init__(self, start: float, end: float, text: str):
            self.start = start
            self.end = end
            self.text = text

    class FakeInfo:
        language = "PT_br"

    class FakeModel:
        def transcribe(self, audio_path: str):
            assert audio_path == r"C:\jobs\audio\audio-16khz.wav"
            return [FakeSegment(1.5, 3.0, " Argentina gana "), FakeSegment(65.2, 70.0, "Messi presses")], FakeInfo()

    def model_factory(model: str, *, device: str, compute_type: str):
        created.update({"model": model, "device": device, "compute_type": compute_type})
        return FakeModel()

    settings = Settings(api_key="test-key", runtime_dir=Path("runtime"), whisper_model="large-v3", device="cuda", compute_type="float16")

    segments, language = FasterWhisperTranscriber(settings=settings, model_factory=model_factory).transcribe(Path(r"C:\jobs\audio\audio-16khz.wav"))

    assert created == {"model": "large-v3", "device": "cuda", "compute_type": "float16"}
    assert segments == [
        TranscriptSegment(id="seg-1", start_ms=1500, end_ms=3000, text="Argentina gana"),
        TranscriptSegment(id="seg-2", start_ms=65200, end_ms=70000, text="Messi presses"),
    ]
    assert language == "pt"


def test_faster_whisper_transcriber_prefers_explicit_model_path():
    created: dict[str, str] = {}

    class FakeModel:
        def transcribe(self, audio_path: str):
            return [], object()

    def model_factory(model: str, *, device: str, compute_type: str):
        created.update({"model": model, "device": device, "compute_type": compute_type})
        return FakeModel()

    settings = Settings(
        api_key="test-key",
        runtime_dir=Path("runtime"),
        whisper_model="large-v3",
        whisper_model_path=r"C:\models\faster-whisper-large-v3",
        device="cuda",
        compute_type="float16",
    )

    FasterWhisperTranscriber(settings=settings, model_factory=model_factory).transcribe(Path("audio-16khz.wav"))

    assert created == {"model": r"C:\models\faster-whisper-large-v3", "device": "cuda", "compute_type": "float16"}


def test_faster_whisper_transcriber_reports_model_failures_as_dependency_failures(monkeypatch):
    monkeypatch.setenv("TRANSCRIPT_SERVICE_API_KEY", "super-secret-api-key")

    class BrokenModel:
        def transcribe(self, audio_path: str):
            raise RuntimeError("cuda unavailable for super-secret-api-key")

    settings = Settings(api_key="test-key", runtime_dir=Path("runtime"), whisper_model="large-v3", device="cuda", compute_type="float16")

    with pytest.raises(DependencyFailure) as failure:
        FasterWhisperTranscriber(settings=settings, model_factory=lambda *args, **kwargs: BrokenModel()).transcribe(Path("audio-16khz.wav"))

    assert failure.value.code == "faster_whisper_failed"
    assert failure.value.message == "RuntimeError: cuda unavailable for [redacted]"


def test_settings_loads_cleanup_ttl_default_override_disable_and_invalid(monkeypatch):
    monkeypatch.delenv("TRANSCRIPT_SERVICE_CLEANUP_TTL_SECONDS", raising=False)
    assert load_settings().cleanup_ttl_seconds == 7 * 24 * 60 * 60

    monkeypatch.setenv("TRANSCRIPT_SERVICE_CLEANUP_TTL_SECONDS", "3600")
    assert load_settings().cleanup_ttl_seconds == 3600

    monkeypatch.setenv("TRANSCRIPT_SERVICE_CLEANUP_TTL_SECONDS", "0")
    assert load_settings().cleanup_ttl_seconds == 0

    monkeypatch.setenv("TRANSCRIPT_SERVICE_CLEANUP_TTL_SECONDS", "not-a-number")
    assert load_settings().cleanup_ttl_seconds == 7 * 24 * 60 * 60


def test_settings_loads_yt_dlp_cookies_and_js_runtime(monkeypatch, tmp_path):
    monkeypatch.delenv("TRANSCRIPT_SERVICE_YT_DLP_COOKIES_PATH", raising=False)
    monkeypatch.delenv("TRANSCRIPT_SERVICE_YT_DLP_JS_RUNTIME", raising=False)
    assert load_settings().yt_dlp_cookies_path == DEFAULT_YT_DLP_COOKIES_PATH
    assert load_settings().yt_dlp_js_runtime is None

    cookies_path = tmp_path / "cookies.txt"
    monkeypatch.setenv("TRANSCRIPT_SERVICE_YT_DLP_COOKIES_PATH", str(cookies_path))
    monkeypatch.setenv("TRANSCRIPT_SERVICE_YT_DLP_JS_RUNTIME", "node")
    settings = load_settings()
    assert settings.yt_dlp_cookies_path == cookies_path
    assert settings.yt_dlp_js_runtime == "node"

    monkeypatch.setenv("TRANSCRIPT_SERVICE_YT_DLP_COOKIES_PATH", "")
    assert load_settings().yt_dlp_cookies_path is None


def test_settings_loads_transcript_fetch_mode_and_remote_fetcher_config(monkeypatch):
    monkeypatch.delenv("TRANSCRIPT_FETCH_MODE", raising=False)
    monkeypatch.delenv("TRANSCRIPT_REMOTE_FETCHER_URL", raising=False)
    monkeypatch.delenv("TRANSCRIPT_REMOTE_FETCHER_TOKEN", raising=False)

    defaults = load_settings()
    assert defaults.transcript_fetch_mode == "local"
    assert defaults.transcript_remote_fetcher_url is None
    assert defaults.transcript_remote_fetcher_token is None

    monkeypatch.setenv("TRANSCRIPT_FETCH_MODE", " remote_only ")
    monkeypatch.setenv("TRANSCRIPT_REMOTE_FETCHER_URL", " https://fetcher.example ")
    monkeypatch.setenv("TRANSCRIPT_REMOTE_FETCHER_TOKEN", " secret-token ")

    configured = load_settings()
    assert configured.transcript_fetch_mode == "remote_only"
    assert configured.transcript_remote_fetcher_url == "https://fetcher.example"
    assert configured.transcript_remote_fetcher_token == "secret-token"


def test_create_downloader_preserves_local_default_path():
    settings = Settings(api_key="test-key", runtime_dir=Path("runtime"), transcript_fetch_mode="local")

    downloader = create_downloader(settings)

    assert isinstance(downloader, YtDlpDownloader)


def test_create_downloader_remote_only_requires_remote_url_and_token():
    missing_url = Settings(api_key="test-key", runtime_dir=Path("runtime"), transcript_fetch_mode="remote_only", transcript_remote_fetcher_token="token")
    with pytest.raises(DependencyFailure) as missing_url_failure:
        create_downloader(missing_url)
    assert missing_url_failure.value.code == "remote_fetcher_config_missing"
    assert missing_url_failure.value.message == "TRANSCRIPT_REMOTE_FETCHER_URL is required when TRANSCRIPT_FETCH_MODE=remote_only"

    missing_token = Settings(api_key="test-key", runtime_dir=Path("runtime"), transcript_fetch_mode="remote_only", transcript_remote_fetcher_url="https://fetcher.example")
    with pytest.raises(DependencyFailure) as missing_token_failure:
        create_downloader(missing_token)
    assert missing_token_failure.value.code == "remote_fetcher_config_missing"
    assert missing_token_failure.value.message == "TRANSCRIPT_REMOTE_FETCHER_TOKEN is required when TRANSCRIPT_FETCH_MODE=remote_only"


class FakeRemoteResponse:
    def __init__(self, *, status: int, body: bytes, headers: dict[str, str] | None = None):
        self.status = status
        self.body = body
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self) -> bytes:
        return self.body


def test_remote_fetcher_downloader_sends_bearer_auth_writes_audio_and_parses_metadata(tmp_path):
    requests = []

    def opener(request, *, timeout: int):
        requests.append((request, timeout))
        return FakeRemoteResponse(
            status=200,
            body=b"audio-bytes",
            headers={"Content-Type": "audio/webm", "X-Prensa-Audio-Info": '{"title":"Remote Title","audio_filename":"source.webm"}'},
        )

    result = RemoteFetcherDownloader(
        fetcher_url="https://fetcher.example",
        token="remote-token",
        opener=opener,
        resolve_media_host=False,
        timeout_seconds=12,
    ).download("https://www.youtube.com/watch?v=abc", tmp_path)

    request, timeout = requests[0]
    assert timeout == 12
    assert request.full_url == "https://fetcher.example/fetch-audio"
    assert request.get_header("Authorization") == "Bearer remote-token"
    assert b'"url": "https://www.youtube.com/watch?v=abc"' in request.data
    assert result.path == tmp_path / "source.webm"
    assert result.path.read_bytes() == b"audio-bytes"
    assert result.title == "Remote Title"


def test_remote_fetcher_downloader_rejects_unsafe_url_before_remote_request(tmp_path):
    calls = []

    def opener(request, *, timeout: int):
        calls.append(request)
        return FakeRemoteResponse(status=200, body=b"audio")

    with pytest.raises(DependencyFailure) as failure:
        RemoteFetcherDownloader(fetcher_url="https://fetcher.example", token="remote-token", opener=opener).download("http://127.0.0.1/private", tmp_path)

    assert failure.value.code == "invalid_url"
    assert calls == []


def test_remote_fetcher_downloader_maps_json_and_http_errors_without_token(tmp_path):
    def json_error_opener(request, *, timeout: int):
        return FakeRemoteResponse(status=502, body=b'{"ok":false,"error":{"code":"yt_dlp_bot_check","message":"Sign in to confirm"}}', headers={"Content-Type": "application/json"})

    with pytest.raises(DependencyFailure) as json_failure:
        RemoteFetcherDownloader(fetcher_url="https://fetcher.example", token="secret-token", opener=json_error_opener, resolve_media_host=False).download("https://youtu.be/abc", tmp_path)

    assert json_failure.value.code == "yt_dlp_bot_check"
    assert json_failure.value.message == "Sign in to confirm"
    assert "secret-token" not in json_failure.value.message

    def http_error_opener(request, *, timeout: int):
        return FakeRemoteResponse(status=500, body=b"upstream exploded", headers={"Content-Type": "text/plain"})

    with pytest.raises(DependencyFailure) as http_failure:
        RemoteFetcherDownloader(fetcher_url="https://fetcher.example", token="secret-token", opener=http_error_opener, resolve_media_host=False).download("https://youtu.be/abc", tmp_path)

    assert http_failure.value.code == "remote_fetcher_http_error"
    assert http_failure.value.message == "Remote fetcher returned HTTP 500"
    assert "secret-token" not in http_failure.value.message


def test_remote_only_downloader_does_not_invoke_local_yt_dlp_on_remote_failure(tmp_path, monkeypatch):
    def fail_if_local_download_runs(self, url: str, job_dir: Path):
        raise AssertionError("local yt-dlp must not run in remote_only mode")

    monkeypatch.setattr(YtDlpDownloader, "download", fail_if_local_download_runs)

    settings = Settings(
        api_key="test-key",
        runtime_dir=Path("runtime"),
        transcript_fetch_mode="remote_only",
        transcript_remote_fetcher_url="https://fetcher.example",
        transcript_remote_fetcher_token="secret-token",
    )
    downloader = create_downloader(settings, remote_opener=lambda request, timeout: FakeRemoteResponse(status=503, body=b"down"))

    with pytest.raises(DependencyFailure) as failure:
        downloader.download("https://youtu.be/abc", tmp_path)

    assert failure.value.code == "remote_fetcher_http_error"
