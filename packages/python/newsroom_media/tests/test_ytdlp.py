from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from newsroom_media.ytdlp import (
    MediaValidationError,
    build_common_args,
    build_download_args,
    build_subtitle_download_args,
    build_subtitle_info_args,
    build_title_args,
    classify_failure,
    error_text,
    run_ytdlp,
    validate_media_url,
)


def test_validate_media_url_accepts_youtube_hosts_and_rejects_private_hosts() -> None:
    assert validate_media_url("https://www.youtube.com/watch?v=abc", resolve_host=False).endswith("abc")
    assert validate_media_url("https://youtu.be/abc", resolve_host=False).endswith("abc")
    with pytest.raises(MediaValidationError) as error:
        validate_media_url("http://127.0.0.1/private", resolve_host=False)
    assert error.value.code == "invalid_url"
    with pytest.raises(MediaValidationError):
        validate_media_url("https://example.local/video", resolve_host=False)


def test_validate_media_url_rejects_hosts_that_resolve_to_private_addresses() -> None:
    with pytest.raises(MediaValidationError):
        validate_media_url("https://www.youtube.com/watch?v=abc", resolver=lambda _host: ["10.0.0.7"])


def test_common_args_include_cookies_only_when_the_file_exists(tmp_path: Path) -> None:
    cookies = tmp_path / "cookies.txt"
    assert "--cookies" not in build_common_args(cookies_path=cookies)
    cookies.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
    args = build_common_args(cookies_path=cookies, js_runtime="node", remote_components="ejs:github")
    assert args[:6] == ["--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3"]
    assert args[6:8] == ["--cookies", str(cookies)]
    assert args[8:10] == ["--js-runtimes", "node"]
    assert args[10:] == ["--remote-components", "ejs:github"]


def test_download_and_subtitle_builders_keep_the_existing_guardrails(tmp_path: Path) -> None:
    output = tmp_path / "source.%(ext)s"
    download = build_download_args("yt-dlp", "https://youtu.be/abc", output, max_filesize="2G", max_duration_seconds=7200)
    assert download[0] == "yt-dlp"
    assert "--max-filesize" in download
    assert "duration <= 7200" in download
    assert "bestaudio/best" in download
    assert download[-1] == "https://youtu.be/abc"

    info = build_subtitle_info_args("yt-dlp", "https://youtu.be/abc")
    assert info[1:3] == ["--skip-download", "--no-playlist"]
    assert info[-2] == "--dump-json"

    automatic = build_subtitle_download_args("yt-dlp", "https://youtu.be/abc", language="es", automatic=True)
    manual = build_subtitle_download_args("yt-dlp", "https://youtu.be/abc", language="es", automatic=False)
    assert "--write-auto-subs" in automatic
    assert "--write-subs" in manual
    assert build_title_args("yt-dlp", "https://youtu.be/abc")[-2:] == ["title", "https://youtu.be/abc"]


def test_classify_failure_maps_the_same_codes_as_the_api_contract() -> None:
    assert classify_failure("ERROR: Sign in to confirm you are not a bot") == "yt_dlp_bot_check"
    assert classify_failure("Video unavailable") == "yt_dlp_private_or_removed"
    assert classify_failure("not available in your country") == "yt_dlp_geo_blocked"
    assert classify_failure("ERROR: Premieres in 2 hours") == "yt_dlp_live_pending"
    assert classify_failure("something else") == "yt_dlp_failed"
    assert error_text(type("Result", (), {"stderr": "  boom\n"})()) == "boom"


def test_run_ytdlp_defaults_to_capture_output_and_custom_runner_fallback() -> None:
    def runner(args, cwd=None, timeout=None):
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=f"{cwd}:{timeout}", stderr="")

    result = run_ytdlp(["yt-dlp", "--version"], cwd="/tmp", timeout=5, runner=runner)
    assert result.stdout == "/tmp:5"
