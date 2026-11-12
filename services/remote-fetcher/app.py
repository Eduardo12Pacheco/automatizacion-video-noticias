from __future__ import annotations

import ipaddress
import json
import os
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, after_this_request, jsonify, request, send_file


app = Flask(__name__)

ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com"}
DEFAULT_MAX_DURATION_SECONDS = 45 * 60
DEFAULT_MAX_FILESIZE = "300M"
DEFAULT_TIMEOUT_SECONDS = 12 * 60


class FetcherError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def require_auth() -> None:
    expected = os.environ.get("FETCHER_API_TOKEN", "").strip()
    if not expected:
        raise FetcherError("server_misconfigured", "FETCHER_API_TOKEN is not configured", 500)
    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {expected}":
        raise FetcherError("unauthorized", "Missing or invalid bearer token", 401)


def is_blocked_address(value: str) -> bool:
    address = ipaddress.ip_address(value)
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_unspecified
        or address.is_multicast
    )


def validate_source_url(url: str) -> str:
    if not url or not isinstance(url, str):
        raise FetcherError("invalid_url", "url is required")
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"}:
        raise FetcherError("invalid_url", "URL must use http or https")
    host = (parsed.hostname or "").strip().casefold()
    if host not in ALLOWED_HOSTS:
        raise FetcherError("invalid_url", "URL host is not allowed")
    try:
        direct_address = ipaddress.ip_address(host)
    except ValueError:
        direct_address = None
    if direct_address and is_blocked_address(str(direct_address)):
        raise FetcherError("invalid_url", "URL host is not allowed")
    try:
        for family, _, _, _, sockaddr in socket.getaddrinfo(host, None):
            if family in {socket.AF_INET, socket.AF_INET6} and sockaddr and is_blocked_address(str(sockaddr[0])):
                raise FetcherError("invalid_url", "URL host resolves to a blocked address")
    except OSError as exc:
        raise FetcherError("invalid_url", "URL host could not be resolved") from exc
    return url.strip()


def classify_yt_dlp_failure(stderr: str) -> str:
    normalized = stderr.casefold()
    if "not a bot" in normalized or "sign in to confirm" in normalized:
        return "yt_dlp_bot_check"
    if "not available in your country" in normalized or "geo-restricted" in normalized or "geo restricted" in normalized:
        return "yt_dlp_geo_blocked"
    if "confirm your age" in normalized or "age-restricted" in normalized or "age restricted" in normalized:
        return "yt_dlp_age_restricted"
    if "private video" in normalized or "has been removed" in normalized or "video unavailable" in normalized:
        return "yt_dlp_private_or_removed"
    if "copyright" in normalized or "blocked it" in normalized or "contains content from" in normalized:
        return "yt_dlp_copyright_blocked"
    if "live event will begin" in normalized or "premiere" in normalized or "upcoming" in normalized:
        return "yt_dlp_live_pending"
    return "yt_dlp_failed"


def run_command(command: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)


def yt_dlp_common_args() -> list[str]:
    args = ["--no-playlist", "--socket-timeout", "30", "--js-runtimes", "node"]
    extractor_args = os.environ.get("YTDLP_EXTRACTOR_ARGS", "youtube:player_client=android,web").strip()
    if extractor_args:
        args.extend(["--extractor-args", extractor_args])
    return args


def fetch_audio(url: str, workdir: Path) -> tuple[Path, dict]:
    max_duration = int(os.environ.get("MAX_DURATION_SECONDS", DEFAULT_MAX_DURATION_SECONDS))
    max_filesize = os.environ.get("MAX_FILESIZE", DEFAULT_MAX_FILESIZE)
    timeout = int(os.environ.get("DOWNLOAD_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))
    output = workdir / "source.%(ext)s"

    metadata_command = [
        "yt-dlp",
        *yt_dlp_common_args(),
        "--dump-single-json",
        url,
    ]
    metadata_result = run_command(metadata_command, timeout=min(timeout, 180))
    metadata: dict = {}
    if metadata_result.returncode == 0 and metadata_result.stdout.strip():
        try:
            metadata = json.loads(metadata_result.stdout)
        except json.JSONDecodeError:
            metadata = {}

    duration = metadata.get("duration")
    if isinstance(duration, (int, float)) and duration > max_duration:
        raise FetcherError("duration_too_long", f"Video duration exceeds {max_duration} seconds")

    command = [
        "yt-dlp",
        *yt_dlp_common_args(),
        "--format",
        "bestaudio/best",
        "--max-filesize",
        max_filesize,
        "--match-filter",
        f"duration <= {max_duration}",
        "--socket-timeout",
        "30",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--output",
        str(output),
        url,
    ]
    result = run_command(command, timeout=timeout)
    if result.returncode != 0:
        stderr = (result.stderr or result.stdout or "yt-dlp failed").strip()
        raise FetcherError(classify_yt_dlp_failure(stderr), stderr[:4000], 502)

    downloaded = sorted(workdir.glob("source.*"))
    if not downloaded:
        raise FetcherError("download_missing", "yt-dlp finished without producing an audio file", 502)

    audio_path = downloaded[0]
    info = {
        "title": metadata.get("title"),
        "duration": metadata.get("duration"),
        "source_host": urlparse(url).hostname,
        "audio_filename": audio_path.name,
        "audio_size_bytes": audio_path.stat().st_size,
    }
    return audio_path, info


@app.errorhandler(FetcherError)
def handle_fetcher_error(error: FetcherError):
    return jsonify({"ok": False, "error": {"code": error.code, "message": error.message}}), error.status


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "prensa-remote-fetcher"})


@app.post("/fetch-audio")
def fetch_audio_endpoint():
    require_auth()
    payload = request.get_json(silent=True) or {}
    url = validate_source_url(payload.get("url", ""))

    temp_root = Path(tempfile.mkdtemp(prefix="prensa-fetch-"))
    audio_path, info = fetch_audio(url, temp_root)

    @after_this_request
    def cleanup(response):
        try:
            shutil.rmtree(temp_root, ignore_errors=True)
        except Exception:
            pass
        return response

    response = send_file(audio_path, as_attachment=True, download_name=audio_path.name, mimetype="application/octet-stream")
    response.headers["X-Prensa-Fetcher"] = "cloud-run"
    response.headers["X-Prensa-Audio-Info"] = json.dumps(info, ensure_ascii=True)
    return response


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
