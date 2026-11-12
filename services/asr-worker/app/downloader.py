from __future__ import annotations

from dataclasses import dataclass
import ipaddress
from pathlib import Path
import socket
import subprocess
from typing import Protocol, Callable
from urllib.parse import urlparse

from .worker import DependencyFailure


class CommandRunner(Protocol):
    def __call__(self, command: list[str], **kwargs): ...


AddressResolver = Callable[[str], list[str]]


ALLOWED_YOUTUBE_HOSTS = frozenset({"youtube.com", "www.youtube.com", "youtu.be"})


def _default_resolver(host: str) -> list[str]:
    addresses: set[str] = set()
    for family, _, _, _, sockaddr in socket.getaddrinfo(host, None):
        if family in {socket.AF_INET, socket.AF_INET6} and sockaddr:
            addresses.add(str(sockaddr[0]))
    return sorted(addresses)


def _is_blocked_address(value: str) -> bool:
    address = ipaddress.ip_address(value)
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_unspecified
        or address.is_multicast
    )


def validate_media_url(url: str, *, resolver: AddressResolver | None = None, resolve_host: bool = True) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise DependencyFailure("invalid_url", "URL must use http or https")
    host = parsed.hostname
    if not host:
        raise DependencyFailure("invalid_url", "URL must include a host")
    normalized_host = host.strip().casefold()
    if normalized_host == "localhost" or normalized_host.endswith(".localhost"):
        raise DependencyFailure("invalid_url", "URL host is not allowed")
    if normalized_host not in ALLOWED_YOUTUBE_HOSTS:
        raise DependencyFailure("invalid_url", "URL host is not allowed")
    try:
        address = ipaddress.ip_address(normalized_host)
    except ValueError:
        address = None
    if address and _is_blocked_address(str(address)):
        raise DependencyFailure("invalid_url", "URL host is not allowed")
    if not resolve_host:
        return
    resolve = resolver or _default_resolver
    try:
        addresses = resolve(normalized_host)
    except OSError as exc:
        raise DependencyFailure("invalid_url", "URL host could not be resolved") from exc
    for resolved in addresses:
        try:
            if _is_blocked_address(resolved):
                raise DependencyFailure("invalid_url", "URL host resolves to a blocked address")
        except ValueError as exc:
            raise DependencyFailure("invalid_url", "URL host resolved to an invalid address") from exc


@dataclass(frozen=True)
class DownloadResult:
    path: Path
    title: str | None = None


class YtDlpDownloader:
    def __init__(
        self,
        *,
        binary: str = "yt-dlp",
        runner: CommandRunner | None = None,
        timeout_seconds: int = 1800,
        cookies_path: Path | str | None = None,
        js_runtime: str | None = None,
        remote_components: str | None = None,
        max_filesize: str | None = "2G",
        max_duration_seconds: int | None = 7200,
        socket_timeout_seconds: int | None = 30,
        retries: int | None = 3,
        fragment_retries: int | None = 3,
        resolve_media_host: bool = True,
        media_host_resolver: AddressResolver | None = None,
    ):
        self.binary = binary
        self.runner = runner or self._run
        self.timeout_seconds = timeout_seconds
        self.cookies_path = Path(cookies_path) if cookies_path else None
        self.js_runtime = js_runtime
        self.remote_components = remote_components
        self.max_filesize = max_filesize
        self.max_duration_seconds = max_duration_seconds
        self.socket_timeout_seconds = socket_timeout_seconds
        self.retries = retries
        self.fragment_retries = fragment_retries
        self.resolve_media_host = resolve_media_host
        self.media_host_resolver = media_host_resolver

    @staticmethod
    def _run(command: list[str], **kwargs):
        return subprocess.run(command, capture_output=True, text=True, check=False, timeout=kwargs.get("timeout"))

    def _run_command(self, command: list[str]):
        try:
            return self.runner(command, timeout=self.timeout_seconds)
        except TypeError:
            return self.runner(command)
        except subprocess.TimeoutExpired as exc:
            raise DependencyFailure("yt_dlp_timeout", f"yt-dlp timed out after {self.timeout_seconds} seconds") from exc

    def _common_args(self) -> list[str]:
        args: list[str] = []
        if self.socket_timeout_seconds and self.socket_timeout_seconds > 0:
            args.extend(["--socket-timeout", str(int(self.socket_timeout_seconds))])
        if self.retries is not None and self.retries >= 0:
            args.extend(["--retries", str(int(self.retries))])
        if self.fragment_retries is not None and self.fragment_retries >= 0:
            args.extend(["--fragment-retries", str(int(self.fragment_retries))])
        if self.cookies_path and self.cookies_path.exists():
            args.extend(["--cookies", str(self.cookies_path)])
        if self.js_runtime:
            args.extend(["--js-runtimes", self.js_runtime])
        if self.remote_components:
            args.extend(["--remote-components", self.remote_components])
        return args

    def _download_guardrail_args(self) -> list[str]:
        args: list[str] = []
        if self.max_filesize:
            args.extend(["--max-filesize", str(self.max_filesize)])
        if self.max_duration_seconds and self.max_duration_seconds > 0:
            args.extend(["--match-filter", f"duration <= {int(self.max_duration_seconds)}"])
        return args

    @staticmethod
    def _classify_failure(stderr: str) -> DependencyFailure:
        normalized = stderr.casefold()
        if (
            "live event will begin" in normalized
            or "premieres in" in normalized
            or "premiere will begin" in normalized
            or "this live stream recording is not available" in normalized
            or "not currently live" in normalized
            or "not started" in normalized
            or "upcoming" in normalized
        ):
            return DependencyFailure("yt_dlp_live_pending", stderr)
        if "copyright" in normalized or "blocked it" in normalized or "contains content from" in normalized:
            return DependencyFailure("yt_dlp_copyright_blocked", stderr)
        if (
            "confirm your age" in normalized
            or "age-restricted" in normalized
            or "age restricted" in normalized
            or "inappropriate for some users" in normalized
        ):
            return DependencyFailure("yt_dlp_age_restricted", stderr)
        if (
            "video unavailable" in normalized
            or "this video is private" in normalized
            or "private video" in normalized
            or "has been removed" in normalized
            or "removed by the uploader" in normalized
            or "this video is unavailable" in normalized
        ):
            return DependencyFailure("yt_dlp_private_or_removed", stderr)
        if "not a bot" in normalized or "sign in to confirm" in normalized:
            return DependencyFailure("yt_dlp_bot_check", stderr)
        if (
            "not available in your country" in normalized
            or "not made this video available in your country" in normalized
            or "geo-restricted" in normalized
            or "geo restricted" in normalized
        ):
            return DependencyFailure("yt_dlp_geo_blocked", stderr)
        return DependencyFailure("yt_dlp_failed", stderr)

    def _read_title(self, url: str) -> str | None:
        command = [self.binary, "--no-playlist", *self._common_args(), "--skip-download", "--print", "title", url]
        completed = self._run_command(command)
        if getattr(completed, "returncode", 0) != 0:
            return None
        title = (getattr(completed, "stdout", "") or "").strip().splitlines()
        return title[0].strip() if title and title[0].strip() else None

    def download(self, url: str, job_dir: Path) -> DownloadResult:
        validate_media_url(url, resolver=self.media_host_resolver, resolve_host=self.resolve_media_host)
        job_dir.mkdir(parents=True, exist_ok=True)
        output_pattern = job_dir / "source.%(ext)s"
        command = [
            self.binary,
            "--no-playlist",
            *self._common_args(),
            *self._download_guardrail_args(),
            "--format", "bestaudio/best",
            "--output", str(output_pattern),
            url,
        ]
        try:
            title = self._read_title(url)
            completed = self._run_command(command)
        except FileNotFoundError as exc:
            raise DependencyFailure("yt_dlp_unavailable", f"yt-dlp binary not found: {self.binary}") from exc
        if getattr(completed, "returncode", 0) != 0:
            stderr = (getattr(completed, "stderr", "") or "yt-dlp failed").strip()
            raise self._classify_failure(stderr)
        downloaded = sorted(job_dir.glob("source.*"))
        if not downloaded:
            raise DependencyFailure("yt_dlp_no_output", "yt-dlp completed but did not create a source file")
        return DownloadResult(path=downloaded[0], title=title)
