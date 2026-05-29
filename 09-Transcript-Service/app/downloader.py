from __future__ import annotations

from dataclasses import dataclass
import ipaddress
from pathlib import Path
import subprocess
from typing import Protocol
from urllib.parse import urlparse

from .worker import DependencyFailure


class CommandRunner(Protocol):
    def __call__(self, command: list[str], **kwargs): ...


def validate_media_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise DependencyFailure("invalid_url", "URL must use http or https")
    host = parsed.hostname
    if not host:
        raise DependencyFailure("invalid_url", "URL must include a host")
    normalized_host = host.strip().casefold()
    if normalized_host == "localhost" or normalized_host.endswith(".localhost"):
        raise DependencyFailure("invalid_url", "URL host is not allowed")
    try:
        address = ipaddress.ip_address(normalized_host)
    except ValueError:
        return
    if address.is_private or address.is_loopback or address.is_link_local or address.is_unspecified or address.is_multicast:
        raise DependencyFailure("invalid_url", "URL host is not allowed")


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
    ):
        self.binary = binary
        self.runner = runner or self._run
        self.timeout_seconds = timeout_seconds
        self.cookies_path = Path(cookies_path) if cookies_path else None
        self.js_runtime = js_runtime
        self.remote_components = remote_components

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
        if self.cookies_path and self.cookies_path.exists():
            args.extend(["--cookies", str(self.cookies_path)])
        if self.js_runtime:
            args.extend(["--js-runtimes", self.js_runtime])
        if self.remote_components:
            args.extend(["--remote-components", self.remote_components])
        return args

    @staticmethod
    def _classify_failure(stderr: str) -> DependencyFailure:
        normalized = stderr.casefold()
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
        validate_media_url(url)
        job_dir.mkdir(parents=True, exist_ok=True)
        output_pattern = job_dir / "source.%(ext)s"
        command = [
            self.binary,
            "--no-playlist",
            *self._common_args(),
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
