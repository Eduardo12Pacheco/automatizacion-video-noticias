from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


DEFAULT_CLEANUP_TTL_SECONDS = 7 * 24 * 60 * 60
SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_YT_DLP_COOKIES_PATH = SERVICE_ROOT / "secrets" / "youtube-cookies.txt"


def _parse_int(value: str, *, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _optional_path_env(name: str, default: Path) -> Path | None:
    value = os.environ.get(name, str(default)).strip()
    return Path(value) if value else None


@dataclass(frozen=True)
class Settings:
    api_key: str
    runtime_dir: Path
    cors_origins: list[str] = field(default_factory=lambda: ["http://localhost:8080"])
    whisper_model: str = "large-v3"
    whisper_model_path: str | None = None
    device: str = "cuda"
    compute_type: str = "float16"
    ffmpeg_binary: str = "ffmpeg"
    yt_dlp_binary: str = "yt-dlp"
    yt_dlp_cookies_path: Path | None = DEFAULT_YT_DLP_COOKIES_PATH
    yt_dlp_js_runtime: str | None = None
    yt_dlp_remote_components: str | None = None
    yt_dlp_max_filesize: str = "2G"
    yt_dlp_max_duration_seconds: int = 7200
    yt_dlp_socket_timeout_seconds: int = 30
    yt_dlp_retries: int = 3
    yt_dlp_fragment_retries: int = 3
    media_url_dns_check: bool = True
    transcript_fetch_mode: str = "local"
    transcript_remote_fetcher_url: str | None = None
    transcript_remote_fetcher_token: str | None = None
    subprocess_timeout_seconds: int = 1800
    cleanup_ttl_seconds: int = DEFAULT_CLEANUP_TTL_SECONDS

    @property
    def whisper_model_source(self) -> str:
        return self.whisper_model_path or self.whisper_model


def load_settings() -> Settings:
    return Settings(
        api_key=os.environ.get("TRANSCRIPT_SERVICE_API_KEY", ""),
        runtime_dir=Path(os.environ.get("TRANSCRIPT_SERVICE_RUNTIME_DIR", "runtime")),
        cors_origins=_split_csv(os.environ.get("TRANSCRIPT_SERVICE_CORS_ORIGINS", "http://localhost:8080")),
        whisper_model=os.environ.get("TRANSCRIPT_SERVICE_WHISPER_MODEL", "large-v3"),
        whisper_model_path=os.environ.get("TRANSCRIPT_SERVICE_WHISPER_MODEL_PATH") or None,
        device=os.environ.get("TRANSCRIPT_SERVICE_DEVICE", "cuda"),
        compute_type=os.environ.get("TRANSCRIPT_SERVICE_COMPUTE_TYPE", "float16"),
        ffmpeg_binary=os.environ.get("TRANSCRIPT_SERVICE_FFMPEG_BINARY", "ffmpeg"),
        yt_dlp_binary=os.environ.get("TRANSCRIPT_SERVICE_YT_DLP_BINARY", "yt-dlp"),
        yt_dlp_cookies_path=_optional_path_env("TRANSCRIPT_SERVICE_YT_DLP_COOKIES_PATH", DEFAULT_YT_DLP_COOKIES_PATH),
        yt_dlp_js_runtime=os.environ.get("TRANSCRIPT_SERVICE_YT_DLP_JS_RUNTIME") or None,
        yt_dlp_remote_components=os.environ.get("TRANSCRIPT_SERVICE_YT_DLP_REMOTE_COMPONENTS") or None,
        yt_dlp_max_filesize=os.environ.get("TRANSCRIPT_SERVICE_YT_DLP_MAX_FILESIZE", "2G"),
        yt_dlp_max_duration_seconds=_parse_int(os.environ.get("TRANSCRIPT_SERVICE_YT_DLP_MAX_DURATION_SECONDS", "7200"), default=7200),
        yt_dlp_socket_timeout_seconds=_parse_int(os.environ.get("TRANSCRIPT_SERVICE_YT_DLP_SOCKET_TIMEOUT_SECONDS", "30"), default=30),
        yt_dlp_retries=_parse_int(os.environ.get("TRANSCRIPT_SERVICE_YT_DLP_RETRIES", "3"), default=3),
        yt_dlp_fragment_retries=_parse_int(os.environ.get("TRANSCRIPT_SERVICE_YT_DLP_FRAGMENT_RETRIES", "3"), default=3),
        media_url_dns_check=os.environ.get("TRANSCRIPT_SERVICE_MEDIA_URL_DNS_CHECK", "1").strip().lower() not in {"0", "false", "no", "off"},
        transcript_fetch_mode=os.environ.get("TRANSCRIPT_FETCH_MODE", "local").strip().casefold() or "local",
        transcript_remote_fetcher_url=(os.environ.get("TRANSCRIPT_REMOTE_FETCHER_URL") or "").strip() or None,
        transcript_remote_fetcher_token=(os.environ.get("TRANSCRIPT_REMOTE_FETCHER_TOKEN") or "").strip() or None,
        subprocess_timeout_seconds=_parse_int(os.environ.get("TRANSCRIPT_SERVICE_SUBPROCESS_TIMEOUT_SECONDS", "1800"), default=1800),
        cleanup_ttl_seconds=_parse_int(
            os.environ.get("TRANSCRIPT_SERVICE_CLEANUP_TTL_SECONDS", str(DEFAULT_CLEANUP_TTL_SECONDS)),
            default=DEFAULT_CLEANUP_TTL_SECONDS,
        ),
    )
