from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import subprocess
from typing import Protocol, Callable

from newsroom_media.ytdlp import (
    MediaValidationError,
    build_common_args,
    build_download_args,
    build_title_args,
    classify_failure,
    run_ytdlp,
    validate_media_url as _validate_shared_media_url,
)

from .worker import DependencyFailure


class CommandRunner(Protocol):
    def __call__(self, command: list[str], **kwargs): ...


AddressResolver = Callable[[str], list[str]]


def validate_media_url(url: str, *, resolver: AddressResolver | None = None, resolve_host: bool = True) -> None:
    try:
        _validate_shared_media_url(url, resolver=resolver, resolve_host=resolve_host)
    except MediaValidationError as exc:
        raise DependencyFailure(exc.code, str(exc)) from exc


@dataclass(frozen=True)
class DownloadResult:
    path: Path
    title: str | None = None


class YtDlpDownloader:
    """Download one YouTube item through the shared yt-dlp integration."""

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
        self.runner = runner
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

    def _run_command(self, command: list[str]):
        try:
            return run_ytdlp(command, timeout=self.timeout_seconds, runner=self.runner)
        except subprocess.TimeoutExpired as exc:
            raise DependencyFailure("yt_dlp_timeout", f"yt-dlp timed out after {self.timeout_seconds} seconds") from exc

    def _common_args(self) -> list[str]:
        return build_common_args(
            cookies_path=self.cookies_path,
            js_runtime=self.js_runtime,
            remote_components=self.remote_components,
            socket_timeout_seconds=self.socket_timeout_seconds,
            retries=self.retries,
            fragment_retries=self.fragment_retries,
        )

    @staticmethod
    def _classify_failure(stderr: str) -> DependencyFailure:
        return DependencyFailure(classify_failure(stderr), stderr)

    def _read_title(self, url: str) -> str | None:
        command = build_title_args(self.binary, url, common_args=self._common_args())
        completed = self._run_command(command)
        if getattr(completed, "returncode", 0) != 0:
            return None
        title = (getattr(completed, "stdout", "") or "").strip().splitlines()
        return title[0].strip() if title and title[0].strip() else None

    def download(self, url: str, job_dir: Path) -> DownloadResult:
        validate_media_url(url, resolver=self.media_host_resolver, resolve_host=self.resolve_media_host)
        job_dir.mkdir(parents=True, exist_ok=True)
        output_pattern = job_dir / "source.%(ext)s"
        command = build_download_args(
            self.binary,
            url,
            output_pattern,
            common_args=self._common_args(),
            max_filesize=self.max_filesize,
            max_duration_seconds=self.max_duration_seconds,
        )
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
