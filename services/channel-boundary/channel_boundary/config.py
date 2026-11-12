from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from .providers import MockChannelBoundaryProvider, YouTubeDataBoundaryProvider


PROHIBITED_CONFIG_NAMES = {
    "CHANNEL_MONITOR_AI_RESCUE_YT_DLP_COOKIES_PATH",
    "YOUTUBE_COOKIE_FILE",
    "YOUTUBE_COOKIES_PATH",
    "YTDLP_COOKIES_PATH",
    "CAPTCHA_API_KEY",
    "BOTCHECK_BYPASS_TOKEN",
    "YOUTUBE_BROWSER_SESSION",
    "YOUTUBE_SESSION_TOKEN",
}


@dataclass(frozen=True)
class BoundaryRuntimeConfig:
    api_token: str
    provider_mode: str
    youtube_api_key: str | None
    public_callback_url: str
    verify_token: str
    local_event_url: str
    local_event_api_key: str


class BoundaryConfigError(RuntimeError):
    pass


def load_boundary_config(environ: Mapping[str, str]) -> BoundaryRuntimeConfig:
    api_token = _text(environ.get("CHANNEL_BOUNDARY_API_TOKEN"))
    provider_mode = (_text(environ.get("CHANNEL_BOUNDARY_PROVIDER")) or "mock").lower()
    youtube_api_key = _text(environ.get("CHANNEL_BOUNDARY_YOUTUBE_API_KEY"))
    prohibited = sorted(name for name in PROHIBITED_CONFIG_NAMES if _text(environ.get(name)))
    errors: list[str] = []
    if not api_token:
        errors.append("CHANNEL_BOUNDARY_API_TOKEN is required")
    if provider_mode not in {"mock", "youtube"}:
        errors.append("CHANNEL_BOUNDARY_PROVIDER must be mock or youtube")
    if provider_mode == "youtube" and not youtube_api_key:
        errors.append("CHANNEL_BOUNDARY_YOUTUBE_API_KEY is required when CHANNEL_BOUNDARY_PROVIDER=youtube")
    if prohibited:
        errors.append("Prohibited cookie/CAPTCHA/bypass config present: " + ", ".join(prohibited))
    if errors:
        raise BoundaryConfigError("; ".join(errors))
    return BoundaryRuntimeConfig(
        api_token=api_token,
            provider_mode=provider_mode,
            youtube_api_key=youtube_api_key,
            public_callback_url=_text(environ.get("CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL")) or "",
            verify_token=_text(environ.get("CHANNEL_BOUNDARY_WEBSUB_VERIFY_TOKEN")) or "",
            local_event_url=_text(environ.get("CHANNEL_BOUNDARY_LOCAL_EVENT_URL")) or "",
            local_event_api_key=_text(environ.get("CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY")) or "",
    )


def build_provider(config: BoundaryRuntimeConfig, *, http_client: Any | None = None) -> Any:
    if config.provider_mode == "youtube":
        return YouTubeDataBoundaryProvider(
            api_key=config.youtube_api_key or "",
            http_client=http_client,
            public_callback_url=config.public_callback_url,
            websub_verify_token=config.verify_token,
        )
    return MockChannelBoundaryProvider()


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
