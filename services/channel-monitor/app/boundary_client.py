from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from .youtube_client import ChannelMetadata, MetadataUnavailable, SubtitleSegment, SubtitleUnavailable, UploadItem, VideoMetadata


@dataclass(frozen=True)
class BoundaryError:
    code: str
    message: str
    retryable: bool = False


@dataclass(frozen=True)
class BoundaryEnvelope:
    ok: bool
    data: dict[str, Any] | list[Any] | None = None
    error: BoundaryError | None = None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> BoundaryEnvelope:
        if bool(payload.get("ok")):
            return cls(ok=True, data=payload.get("data") or {}, error=None)
        raw_error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
        return cls(
            ok=False,
            data=None,
            error=BoundaryError(
                code=str(raw_error.get("code") or "boundary_upstream_failed"),
                message=str(raw_error.get("message") or "Boundary request failed"),
                retryable=bool(raw_error.get("retryable", False)),
            ),
        )


class BoundaryRequest(Protocol):
    endpoint: str

    def payload(self) -> dict[str, Any]: ...


class BoundaryHttpClient(Protocol):
    def post_json(self, url: str, *, payload: dict[str, Any], headers: dict[str, str], timeout: int) -> dict[str, Any]: ...


class BoundaryRequestError(RuntimeError):
    def __init__(self, *, code: str, message: str, retryable: bool = False):
        self.code = code
        self.retryable = retryable
        super().__init__(message or code)


class BoundaryMetadataUnavailable(MetadataUnavailable):
    def __init__(self, video_id: str, *, code: str, message: str, retryable: bool = False):
        self.reason = code
        self.retryable = retryable
        super().__init__(video_id, message or code)


@dataclass(frozen=True)
class ChannelResolveRequest:
    source: str
    endpoint: str = "/v1/channels/resolve"

    def payload(self) -> dict[str, Any]:
        return {"source": self.source}


@dataclass(frozen=True)
class VideoMetadataRequest:
    video_id: str
    endpoint: str = "/v1/videos/metadata"

    def payload(self) -> dict[str, Any]:
        return {"video_id": self.video_id}


@dataclass(frozen=True)
class UploadsPlaylistRequest:
    uploads_playlist_id: str
    page_limit: int
    item_limit: int
    endpoint: str = "/v1/playlists/uploads"

    def payload(self) -> dict[str, Any]:
        return {
            "uploads_playlist_id": self.uploads_playlist_id,
            "page_limit": max(1, int(self.page_limit)),
            "item_limit": max(1, int(self.item_limit)),
        }


@dataclass(frozen=True)
class SubtitleFetchRequest:
    video_id: str
    source_language: str | None
    default_language: str
    endpoint: str = "/v1/subtitles/fetch"

    def payload(self) -> dict[str, Any]:
        payload = {"video_id": self.video_id, "default_language": self.default_language.strip() or "en"}
        if self.source_language and self.source_language.strip():
            payload["source_language"] = self.source_language.strip()
        return payload


class ChannelNetworkBoundaryClient:
    provider_name = "channel-network-boundary"

    def __init__(self, *, base_url: str, token: str, http: BoundaryHttpClient | None = None, timeout: int = 15):
        self.base_url = base_url.strip().rstrip("/")
        self.token = token.strip()
        self.http = http or _UrllibJsonHttpClient()
        self.timeout = int(timeout)

    def resolve_channel(self, source: str) -> ChannelMetadata:
        data = self._request(ChannelResolveRequest(source=source))
        return ChannelMetadata(
            channel_id=str(data.get("channel_id") or ""),
            title=str(data.get("title") or ""),
            uploads_playlist_id=_optional_text(data.get("uploads_playlist_id")),
        )

    def get_video_metadata(self, video_id: str) -> VideoMetadata:
        try:
            data = self._request(VideoMetadataRequest(video_id=video_id))
        except BoundaryRequestError as exc:
            raise BoundaryMetadataUnavailable(
                video_id,
                code=exc.code,
                message=str(exc),
                retryable=exc.retryable,
            ) from exc
        return VideoMetadata(
            video_id=str(data.get("video_id") or video_id),
            channel_id=str(data.get("channel_id") or ""),
            title=str(data.get("title") or ""),
            published_at=_optional_text(data.get("published_at")),
            live_status=str(data.get("live_status") or "none"),
        )

    def list_upload_video_ids(self, uploads_playlist_id: str, *, limit: int) -> list[str]:
        return [item.video_id for item in self.iter_upload_items(uploads_playlist_id, page_limit=1, item_limit=limit)]

    def iter_upload_items(self, uploads_playlist_id: str, *, page_limit: int = 20, item_limit: int = 1000):
        data = self._request(
            UploadsPlaylistRequest(
                uploads_playlist_id=uploads_playlist_id,
                page_limit=page_limit,
                item_limit=item_limit,
            )
        )
        raw_items = data.get("items") if isinstance(data, dict) else data
        for item in raw_items or []:
            if not isinstance(item, dict):
                continue
            video_id = str(item.get("video_id") or "").strip()
            if not video_id:
                continue
            yield UploadItem(
                video_id=video_id,
                published_at=_optional_text(item.get("published_at")),
                page_token=_optional_text(item.get("page_token")),
            )

    def fetch(self, *, video_id: str, source_language: str | None, default_language: str) -> list[SubtitleSegment]:
        try:
            data = self._request(
                SubtitleFetchRequest(
                    video_id=video_id,
                    source_language=source_language,
                    default_language=default_language,
                )
            )
        except BoundaryRequestError as exc:
            raise SubtitleUnavailable(
                video_id,
                default_language or "en",
                reason=exc.code,
                details={"provider": self.provider_name, "retryable": exc.retryable, "error_code": exc.code},
            ) from exc
        raw_segments = data.get("segments") if isinstance(data, dict) else data
        return [
            SubtitleSegment(
                start_ms=int(segment.get("start_ms") or 0),
                end_ms=int(segment.get("end_ms") or 0),
                text=str(segment.get("text") or ""),
                language=str(segment.get("language") or default_language or "en"),
            )
            for segment in raw_segments or []
            if isinstance(segment, dict) and str(segment.get("text") or "").strip()
        ]

    def _request(self, request: BoundaryRequest) -> dict[str, Any] | list[Any]:
        if not self.base_url or not self.token:
            raise BoundaryRequestError(
                code="boundary_misconfigured",
                message="Channel network boundary URL/token are required",
                retryable=False,
            )
        try:
            payload = self.http.post_json(
                f"{self.base_url}{request.endpoint}",
                payload=request.payload(),
                headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
                timeout=self.timeout,
            )
        except BoundaryRequestError:
            raise
        except Exception as exc:
            raise BoundaryRequestError(
                code="boundary_unreachable",
                message="Channel network boundary is unreachable",
                retryable=True,
            ) from exc
        envelope = BoundaryEnvelope.from_payload(payload if isinstance(payload, dict) else {})
        if envelope.ok:
            return envelope.data or {}
        error = envelope.error or BoundaryError(code="boundary_upstream_failed", message="Boundary request failed")
        raise BoundaryRequestError(code=error.code, message=error.message, retryable=error.retryable)


class _UrllibJsonHttpClient:
    def post_json(self, url: str, *, payload: dict[str, Any], headers: dict[str, str], timeout: int) -> dict[str, Any]:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8") if exc.fp else ""
            if body:
                try:
                    return json.loads(body)
                except json.JSONDecodeError:
                    pass
            if int(exc.code) in {401, 403}:
                return {"ok": False, "error": {"code": "unauthorized", "message": "Boundary request unauthorized", "retryable": False}}
            return {"ok": False, "error": {"code": "boundary_upstream_failed", "message": "Boundary HTTP request failed", "retryable": int(exc.code) >= 500}}


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
