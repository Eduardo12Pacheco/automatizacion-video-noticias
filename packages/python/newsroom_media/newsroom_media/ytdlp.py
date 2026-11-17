"""yt-dlp argument builders, process runner and URL guardrails.

Both the ASR worker and the channel monitor run yt-dlp. Keeping the commands,
the SSRF guard and the failure taxonomy here means a guardrail added in one
service automatically applies to the other.
"""

from __future__ import annotations

import inspect
import ipaddress
import socket
import subprocess
from pathlib import Path
from typing import Callable, Protocol
from urllib.parse import urlparse

from .url_guard import is_blocked_address

ALLOWED_YOUTUBE_HOSTS = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"})

AddressResolver = Callable[[str], list[str]]


class MediaValidationError(RuntimeError):
    """A media URL that failed the local YouTube guard."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class CommandRunner(Protocol):
    def __call__(self, args: list[str], *, cwd: str | None = None, timeout: float | None = None): ...


def _default_resolver(host: str) -> list[str]:
    addresses: set[str] = set()
    for family, _, _, _, sockaddr in socket.getaddrinfo(host, None):
        if family in {socket.AF_INET, socket.AF_INET6} and sockaddr:
            addresses.add(str(sockaddr[0]))
    return sorted(addresses)


def _is_blocked_address(value: str) -> bool:
    address = ipaddress.ip_address(value)
    return is_blocked_address(str(address))


def validate_media_url(
    url: str,
    *,
    resolver: AddressResolver | None = None,
    resolve_host: bool = True,
) -> str:
    """Return the URL or raise MediaValidationError for unsupported hosts."""

    parsed = urlparse(str(url or ""))
    if parsed.scheme not in {"http", "https"}:
        raise MediaValidationError("invalid_url", "URL must use http or https")
    host = parsed.hostname
    if not host:
        raise MediaValidationError("invalid_url", "URL must include a host")
    normalized_host = host.strip().casefold()
    if normalized_host == "localhost" or normalized_host.endswith(".localhost"):
        raise MediaValidationError("invalid_url", "URL host is not allowed")
    if normalized_host not in ALLOWED_YOUTUBE_HOSTS:
        raise MediaValidationError("invalid_url", "URL host is not allowed")
    try:
        address = ipaddress.ip_address(normalized_host)
    except ValueError:
        address = None
    if address and _is_blocked_address(str(address)):
        raise MediaValidationError("invalid_url", "URL host is not allowed")
    if not resolve_host:
        return url

    resolve = resolver or _default_resolver
    try:
        addresses = resolve(normalized_host)
    except OSError as exc:
        raise MediaValidationError("invalid_url", "URL host could not be resolved") from exc
    for resolved in addresses:
        try:
            if _is_blocked_address(resolved):
                raise MediaValidationError("invalid_url", "URL host resolves to a blocked address")
        except ValueError as exc:
            raise MediaValidationError("invalid_url", "URL host resolved to an invalid address") from exc
    return url


def _cookie_args(cookies_path: Path | str | None) -> list[str]:
    path = Path(cookies_path) if cookies_path else None
    return ["--cookies", str(path)] if path and path.exists() else []


def build_common_args(
    *,
    cookies_path: Path | str | None = None,
    js_runtime: str | None = None,
    remote_components: str | None = None,
    socket_timeout_seconds: int | None = 30,
    retries: int | None = 3,
    fragment_retries: int | None = 3,
) -> list[str]:
    args: list[str] = []
    if socket_timeout_seconds and socket_timeout_seconds > 0:
        args.extend(["--socket-timeout", str(int(socket_timeout_seconds))])
    if retries is not None and retries >= 0:
        args.extend(["--retries", str(int(retries))])
    if fragment_retries is not None and fragment_retries >= 0:
        args.extend(["--fragment-retries", str(int(fragment_retries))])
    args.extend(_cookie_args(cookies_path))
    if js_runtime:
        args.extend(["--js-runtimes", str(js_runtime)])
    if remote_components:
        args.extend(["--remote-components", str(remote_components)])
    return args


def build_title_args(
    binary: str,
    url: str,
    *,
    common_args: list[str] | None = None,
) -> list[str]:
    return [binary, "--no-playlist", *(common_args or []), "--skip-download", "--print", "title", url]


def build_download_args(
    binary: str,
    url: str,
    output_pattern: Path | str,
    *,
    common_args: list[str] | None = None,
    max_filesize: str | None = "2G",
    max_duration_seconds: int | None = 7200,
) -> list[str]:
    args = [binary, "--no-playlist", *(common_args or [])]
    if max_filesize:
        args.extend(["--max-filesize", str(max_filesize)])
    if max_duration_seconds and max_duration_seconds > 0:
        args.extend(["--match-filter", f"duration <= {int(max_duration_seconds)}"])
    args.extend(["--format", "bestaudio/best", "--output", str(output_pattern), url])
    return args


def build_subtitle_info_args(
    binary: str,
    url: str,
    *,
    common_args: list[str] | None = None,
) -> list[str]:
    return [binary, "--skip-download", "--no-playlist", *(common_args or []), "--dump-json", url]


def build_subtitle_download_args(
    binary: str,
    url: str,
    *,
    language: str,
    automatic: bool,
    common_args: list[str] | None = None,
) -> list[str]:
    write_flag = "--write-auto-subs" if automatic else "--write-subs"
    return [
        binary,
        "--skip-download",
        "--no-playlist",
        *(common_args or []),
        write_flag,
        "--sub-langs",
        language,
        "--sub-format",
        "vtt/json3/srv3/srv2/srv1",
        "--output",
        "%(id)s.%(ext)s",
        url,
    ]


def run_ytdlp(
    args: list[str],
    *,
    cwd: str | Path | None = None,
    timeout: float | None = 90,
    runner: CommandRunner | None = None,
) -> subprocess.CompletedProcess[str]:
    if runner is not None:
        try:
            parameters = inspect.signature(runner).parameters
        except (TypeError, ValueError):
            parameters = {}
        accepts_kwargs = any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters.values())
        kwargs = {}
        if accepts_kwargs or "cwd" in parameters:
            kwargs["cwd"] = cwd
        if accepts_kwargs or "timeout" in parameters:
            kwargs["timeout"] = timeout
        return runner(args, **kwargs)
    return subprocess.run(
        args,
        cwd=str(cwd) if cwd is not None else None,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )


def classify_failure(stderr: str) -> str:
    """Map yt-dlp stderr to the stable failure codes the API returns."""

    normalized = str(stderr or "").casefold()
    if any(
        token in normalized
        for token in (
            "live event will begin",
            "premieres in",
            "premiere will begin",
            "this live stream recording is not available",
            "not currently live",
            "not started",
            "upcoming",
        )
    ):
        return "yt_dlp_live_pending"
    if any(token in normalized for token in ("copyright", "blocked it", "contains content from")):
        return "yt_dlp_copyright_blocked"
    if any(
        token in normalized
        for token in (
            "confirm your age",
            "age-restricted",
            "age restricted",
            "inappropriate for some users",
        )
    ):
        return "yt_dlp_age_restricted"
    if any(
        token in normalized
        for token in (
            "video unavailable",
            "this video is private",
            "private video",
            "has been removed",
            "removed by the uploader",
            "this video is unavailable",
        )
    ):
        return "yt_dlp_private_or_removed"
    if any(token in normalized for token in ("not a bot", "sign in to confirm")):
        return "yt_dlp_bot_check"
    if any(
        token in normalized
        for token in (
            "not available in your country",
            "not made this video available in your country",
            "geo-restricted",
            "geo restricted",
        )
    ):
        return "yt_dlp_geo_blocked"
    return "yt_dlp_failed"


def error_text(result: object) -> str:
    text = str(getattr(result, "stderr", "") or getattr(result, "stdout", "") or "yt-dlp failed")
    return " ".join(text.split())[:500]
