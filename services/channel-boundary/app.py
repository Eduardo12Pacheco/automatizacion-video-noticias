from __future__ import annotations

import json
import logging
import os
import urllib.request
from datetime import UTC, datetime
from typing import Any, Callable, Mapping
from xml.etree import ElementTree

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from channel_boundary.config import BoundaryConfigError, build_provider, load_boundary_config
from channel_boundary.errors import BoundaryProviderError as BoundaryError


LOGGER = logging.getLogger("channel_network_boundary")
SERVICE_NAME = "channel-network-boundary"
LOCAL_EVENT_USER_AGENT = "channel-network-boundary/1.0"
SECRET_ENV_HINTS = ("TOKEN", "SECRET", "KEY", "COOKIE", "CAPTCHA", "BYPASS", "SESSION")


class LocalEventForwarder:
    def forward_event(self, *, url: str, api_key: str, event: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            url,
            data=json.dumps(event).encode("utf-8"),
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": LOCAL_EVENT_USER_AGENT,
                "x-boundary-event-api-key": api_key,
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - configured local/API-gateway event URL only.
            body = response.read().decode("utf-8")
        return json.loads(body) if body else {"status": "accepted"}


def create_app(
    *,
    provider: Any | None = None,
    event_forwarder: Any | None = None,
    environ: Mapping[str, str] | None = None,
    http_client: Any | None = None,
) -> FastAPI:
    active_environ = os.environ if environ is None else environ
    config = load_boundary_config(active_environ)
    boundary_provider = provider or build_provider(config, http_client=http_client)
    forwarder = event_forwarder or LocalEventForwarder()
    app = FastAPI(title=SERVICE_NAME)
    expected_token = config.api_token
    verify_token = config.verify_token
    local_event_url = config.local_event_url
    local_event_api_key = config.local_event_api_key

    @app.exception_handler(BoundaryError)
    async def handle_boundary_error(_request: Request, error: BoundaryError):
        response, status = error_envelope(error, environ=active_environ)
        LOGGER.warning("boundary_error code=%s message=%s", error.code, redact(response["error"]["message"], environ=active_environ))
        return JSONResponse(response, status_code=status)

    @app.exception_handler(BoundaryConfigError)
    async def handle_config_error(_request: Request, error: BoundaryConfigError):
        response, status = error_envelope(BoundaryError(code="server_misconfigured", message=str(error), retryable=False, status=500), environ=active_environ)
        LOGGER.error("boundary_config_error message=%s", redact(str(error), environ=active_environ))
        return JSONResponse(response, status_code=status)

    @app.exception_handler(Exception)
    async def handle_unexpected_error(_request: Request, error: Exception):
        LOGGER.exception("boundary_unexpected_error message=%s", redact(str(error), environ=active_environ))
        response, status = error_envelope(
            BoundaryError(code="boundary_upstream_failed", message="Boundary request failed", retryable=True, status=502), environ=active_environ
        )
        return JSONResponse(response, status_code=status)

    @app.get("/health")
    async def health():
        return ok_envelope({"service": SERVICE_NAME, "provider": provider_name(boundary_provider)})

    @app.middleware("http")
    async def authenticate_v1_requests(request: Request, call_next):
        if request.url.path.startswith("/v1/") and request.url.path != "/v1/websub/callback":
            if not expected_token:
                raise BoundaryConfigError("CHANNEL_BOUNDARY_API_TOKEN is required")
            if request.headers.get("Authorization", "") != f"Bearer {expected_token}":
                response, status = error_envelope(
                    BoundaryError(code="unauthorized", message="Missing or invalid bearer token", retryable=False, status=401)
                )
                return JSONResponse(response, status_code=status)
        return await call_next(request)

    route_provider_endpoint(app, "/v1/channels/resolve", boundary_provider.resolve_channel, required_fields=("source",))
    route_provider_endpoint(app, "/v1/videos/metadata", boundary_provider.video_metadata, required_fields=("video_id",))
    route_provider_endpoint(app, "/v1/playlists/uploads", boundary_provider.uploads_playlist, required_fields=("uploads_playlist_id",))
    route_provider_endpoint(app, "/v1/subtitles/fetch", boundary_provider.subtitles, required_fields=("video_id",))
    route_provider_endpoint(app, "/v1/websub/renew", boundary_provider.renew_websub, required_fields=("channel_id",))

    @app.get("/v1/websub/callback")
    async def websub_callback_verify(request: Request):
        if verify_token and request.query_params.get("hub.verify_token") != verify_token:
            response, status = error_envelope(BoundaryError(code="invalid_verify_token", message="Invalid WebSub verify token", retryable=False, status=403))
            return JSONResponse(response, status_code=status)
        challenge = request.query_params.get("hub.challenge")
        if not challenge:
            response, status = error_envelope(BoundaryError(code="missing_challenge", message="Missing WebSub challenge", retryable=False, status=400))
            return JSONResponse(response, status_code=status)
        return PlainTextResponse(challenge)

    @app.post("/v1/websub/callback", status_code=202)
    async def websub_callback_intake(request: Request):
        if not local_event_url or not local_event_api_key:
            raise BoundaryError(code="boundary_misconfigured", message="Local WebSub event forwarding is not configured", retryable=True, status=503)
        body = await request.body()
        event = normalize_websub_event(body, received_at=optional_text(request.headers.get("x-received-at")) or utc_now_iso())
        forwarder.forward_event(url=local_event_url, api_key=local_event_api_key, event=event)
        return ok_envelope(
            {
                "status": "accepted",
                "event_id": event["event_id"],
                "channel_id": event["channel_id"],
                "video_ids": event["video_ids"],
                "forwarded": True,
            }
        )
    return app


def route_provider_endpoint(
    app: FastAPI,
    path: str,
    handler: Callable[[Mapping[str, Any]], dict[str, Any]],
    *,
    required_fields: tuple[str, ...],
) -> None:
    async def endpoint(request: Request):
        payload = await request.json()
        if not isinstance(payload, dict):
            raise BoundaryError(code="invalid_request", message="JSON object payload is required", retryable=False, status=400)
        for field in required_fields:
            required_text(payload, field)
        data = handler(payload)
        return ok_envelope(data)

    app.add_api_route(path, endpoint, methods=["POST"])


def validate_startup_config(environ: Mapping[str, str]) -> None:
    load_boundary_config(environ)


def error_envelope(error: BoundaryError, *, environ: Mapping[str, str] | None = None) -> tuple[dict[str, Any], int]:
    return (
        {"ok": False, "error": {"code": error.code, "message": redact(error.message, environ=environ), "retryable": bool(error.retryable)}},
        int(error.status),
    )


def ok_envelope(data: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "data": data}


def required_text(payload: Mapping[str, Any], field: str) -> str:
    value = optional_text(payload.get(field))
    if not value:
        raise BoundaryError(code="invalid_request", message=f"{field} is required", retryable=False, status=400)
    return value


def optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def positive_int(value: Any, *, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(1, number)


def provider_name(provider: Any) -> str:
    return str(getattr(provider, "provider_name", "mock") or "mock")


def normalize_websub_event(body: bytes, *, received_at: str) -> dict[str, Any]:
    try:
        root = ElementTree.fromstring(body)
    except ElementTree.ParseError as exc:
        raise BoundaryError(code="invalid_websub_payload", message="WebSub callback XML is invalid", retryable=False, status=400) from exc
    namespaces = {"yt": "http://www.youtube.com/xml/schemas/2015"}
    video_ids = unique_texts(element.text for element in root.findall(".//yt:videoId", namespaces))
    channel_ids = unique_texts(element.text for element in root.findall(".//yt:channelId", namespaces))
    channel_id = channel_ids[0] if channel_ids else None
    if not video_ids:
        raise BoundaryError(code="invalid_websub_payload", message="WebSub callback did not include video ids", retryable=False, status=400)
    event_channel = channel_id or "unknown-channel"
    return {
        "event_id": f"websub:{event_channel}:{','.join(video_ids)}",
        "channel_id": channel_id,
        "video_ids": video_ids,
        "received_at": received_at,
    }


def unique_texts(values: Any) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = optional_text(value)
        if text and text not in seen:
            seen.add(text)
            normalized.append(text)
    return normalized


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def redact(value: Any, *, environ: Mapping[str, str] | None = None) -> str:
    text = str(value)
    secrets = os.environ if environ is None else environ
    for name, secret in secrets.items():
        if any(hint in name.upper() for hint in SECRET_ENV_HINTS) and secret:
            text = text.replace(secret, "[REDACTED]")
    return text


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(create_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
