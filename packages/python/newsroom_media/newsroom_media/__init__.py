"""Shared local media helpers (yt-dlp process integration)."""

from .ytdlp import (
    ALLOWED_YOUTUBE_HOSTS,
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

__all__ = [
    "ALLOWED_YOUTUBE_HOSTS",
    "MediaValidationError",
    "build_common_args",
    "build_download_args",
    "build_subtitle_download_args",
    "build_subtitle_info_args",
    "build_title_args",
    "classify_failure",
    "error_text",
    "run_ytdlp",
    "validate_media_url",
]
