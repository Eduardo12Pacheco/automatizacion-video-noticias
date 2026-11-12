from __future__ import annotations

from pathlib import Path

from app.preflight import PreflightChecker, collect_preflight_failures
from app.settings import Settings


class HealthResponse:
    def __init__(self, *, status: int = 200, body: bytes = b"ok"):
        self.status = status
        self.body = body
        self.headers = {"Content-Type": "text/plain"}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self) -> bytes:
        return self.body


def _settings(**overrides) -> Settings:
    values = {"api_key": "test-key", "runtime_dir": Path("runtime"), "media_url_dns_check": False}
    values.update(overrides)
    return Settings(**values)


def test_preflight_local_mode_preserves_yt_dlp_dependency_check(monkeypatch):
    which_calls: list[str] = []

    def fake_which(binary: str):
        which_calls.append(binary)
        return f"C:/bin/{binary}.exe"

    monkeypatch.setattr("app.preflight.shutil.which", fake_which)
    monkeypatch.setattr("app.preflight.importlib.util.find_spec", lambda name: object())

    report = PreflightChecker(_settings(transcript_fetch_mode="local", yt_dlp_binary="yt-dlp-custom")).report()

    assert which_calls == ["ffmpeg", "yt-dlp-custom"]
    assert report["yt_dlp"] == {"status": "ok", "path": "C:/bin/yt-dlp-custom.exe"}
    assert collect_preflight_failures(report) == []


def test_preflight_remote_only_skips_yt_dlp_and_checks_remote_health(monkeypatch):
    which_calls: list[str] = []
    remote_requests = []

    def fake_which(binary: str):
        which_calls.append(binary)
        return f"C:/bin/{binary}.exe"

    def opener(request, *, timeout: int):
        remote_requests.append((request, timeout))
        return HealthResponse(status=200)

    monkeypatch.setattr("app.preflight.shutil.which", fake_which)
    monkeypatch.setattr("app.preflight.importlib.util.find_spec", lambda name: object())

    report = PreflightChecker(
        _settings(
            transcript_fetch_mode="remote_only",
            transcript_remote_fetcher_url="https://fetcher.example/base",
            transcript_remote_fetcher_token="secret-token",
        ),
        remote_opener=opener,
        remote_timeout_seconds=2,
    ).report()

    assert which_calls == ["ffmpeg"]
    assert "yt_dlp" not in report
    assert report["remote_fetcher"] == {"status": "ok", "health_url": "https://fetcher.example/base/health"}
    request, timeout = remote_requests[0]
    assert timeout == 2
    assert request.full_url == "https://fetcher.example/base/health"
    assert request.get_method() == "GET"
    assert request.data is None
    assert request.get_header("Authorization") is None
    assert "/fetch-audio" not in request.full_url
    assert "youtube" not in (request.full_url + str(request.headers)).casefold()
    assert collect_preflight_failures(report) == []


def test_preflight_remote_only_reports_missing_url_and_token_without_leaking_token(monkeypatch):
    which_calls: list[str] = []

    monkeypatch.setattr("app.preflight.shutil.which", lambda binary: which_calls.append(binary) or f"C:/bin/{binary}.exe")
    monkeypatch.setattr("app.preflight.importlib.util.find_spec", lambda name: object())

    report = PreflightChecker(_settings(transcript_fetch_mode="remote_only", transcript_remote_fetcher_token="secret-token")).report()
    failures = collect_preflight_failures(report)

    assert which_calls == ["ffmpeg"]
    assert report["remote_fetcher"] == {
        "status": "config_missing",
        "message": "TRANSCRIPT_REMOTE_FETCHER_URL is required when TRANSCRIPT_FETCH_MODE=remote_only",
    }
    assert failures == [
        {
            "code": "remote_fetcher_config_missing",
            "dependency": "remote_fetcher",
            "message": "TRANSCRIPT_REMOTE_FETCHER_URL is required when TRANSCRIPT_FETCH_MODE=remote_only",
        }
    ]
    assert "secret-token" not in str(report)
    assert "secret-token" not in str(failures)

    missing_token = PreflightChecker(
        _settings(transcript_fetch_mode="remote_only", transcript_remote_fetcher_url="https://fetcher.example")
    ).report()
    assert missing_token["remote_fetcher"] == {
        "status": "config_missing",
        "message": "TRANSCRIPT_REMOTE_FETCHER_TOKEN is required when TRANSCRIPT_FETCH_MODE=remote_only",
    }


def test_preflight_remote_only_reports_invalid_remote_url_without_opening_remote(monkeypatch):
    remote_calls: list[str] = []

    def opener(request, *, timeout: int):
        remote_calls.append(request.full_url)
        raise AssertionError("invalid remote fetcher URL must not call opener")

    monkeypatch.setattr("app.preflight.shutil.which", lambda binary: f"C:/bin/{binary}.exe")
    monkeypatch.setattr("app.preflight.importlib.util.find_spec", lambda name: object())

    for invalid_url in ["fetcher.example", "https:///missing-host"]:
        report = PreflightChecker(
            _settings(
                transcript_fetch_mode="remote_only",
                transcript_remote_fetcher_url=invalid_url,
                transcript_remote_fetcher_token="secret-token",
            ),
            remote_opener=opener,
        ).report()
        failures = collect_preflight_failures(report)

        assert report["remote_fetcher"] == {
            "status": "remote_fetcher_config_invalid",
            "message": "TRANSCRIPT_REMOTE_FETCHER_URL must be an absolute http(s) URL with a host",
        }
        assert failures == [
            {
                "code": "remote_fetcher_config_invalid",
                "dependency": "remote_fetcher",
                "message": "TRANSCRIPT_REMOTE_FETCHER_URL must be an absolute http(s) URL with a host",
            }
        ]
        assert "secret-token" not in str(report)
        assert "secret-token" not in str(failures)

    assert remote_calls == []


def test_preflight_remote_only_reports_non_ok_remote_health_without_fetch_audio(monkeypatch):
    remote_urls: list[str] = []

    def opener(request, *, timeout: int):
        remote_urls.append(request.full_url)
        return HealthResponse(status=503, body=b"not ready")

    monkeypatch.setattr("app.preflight.shutil.which", lambda binary: f"C:/bin/{binary}.exe")
    monkeypatch.setattr("app.preflight.importlib.util.find_spec", lambda name: object())

    report = PreflightChecker(
        _settings(
            transcript_fetch_mode="remote_only",
            transcript_remote_fetcher_url="https://fetcher.example",
            transcript_remote_fetcher_token="secret-token",
        ),
        remote_opener=opener,
    ).report()
    failures = collect_preflight_failures(report)

    assert remote_urls == ["https://fetcher.example/health"]
    assert all("fetch-audio" not in url for url in remote_urls)
    assert report["remote_fetcher"] == {
        "status": "remote_fetcher_health_non_ok",
        "health_url": "https://fetcher.example/health",
        "message": "Remote fetcher health returned HTTP 503",
    }
    assert failures == [
        {
            "code": "remote_fetcher_health_non_ok",
            "dependency": "remote_fetcher",
            "message": "Remote fetcher health returned HTTP 503",
        }
    ]
    assert "secret-token" not in str(report)
    assert "secret-token" not in str(failures)
