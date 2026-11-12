from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable


class AsrWorkerError(RuntimeError):
    def __init__(self, code: str, message: str, status: int | None = None):
        self.code = code
        self.message = message
        self.status = status
        super().__init__(message)


class AsrWorkerClient:
    """Thin HTTP client for the single `services/asr-worker` Whisper service.

    The subtitles and renderer services no longer load faster-whisper in
    process; both call this client so the model and the GPU slot are owned by
    one worker.
    """

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:8765",
        api_key: str = "",
        timeout_seconds: float = 1800.0,
        opener: Callable[..., Any] | None = None,
    ):
        self.base_url = str(base_url or "").rstrip("/")
        self.api_key = api_key
        self.timeout_seconds = float(timeout_seconds)
        self._opener = opener or urllib.request.urlopen

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "AsrWorkerClient":
        import os

        values = os.environ if env is None else env
        return cls(
            base_url=values.get("ASR_WORKER_URL") or values.get("SUBS_ASR_URL") or "http://127.0.0.1:8765",
            api_key=values.get("TRANSCRIPT_SERVICE_API_KEY") or values.get("ASR_WORKER_API_KEY") or "",
            timeout_seconds=float(values.get("ASR_WORKER_TIMEOUT_SECONDS") or 1800),
        )

    def transcribe(self, audio_path: Path, language: str | None = None) -> tuple[list[dict[str, Any]], str | None]:
        payload: dict[str, Any] = {"audio_path": str(audio_path)}
        if language and language != "auto":
            payload["language"] = language
        request = urllib.request.Request(
            f"{self.base_url}/api/radar/transcribe",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json", "x-api-key": self.api_key},
            method="POST",
        )
        try:
            with self._opener(request, timeout=self.timeout_seconds) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = _error_detail(exc)
            raise AsrWorkerError(
                str(detail.get("code") or "asr_worker_http_error"),
                str(detail.get("message") or f"ASR worker returned HTTP {exc.code}"),
                exc.code,
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise AsrWorkerError("asr_worker_unavailable", f"ASR worker unavailable: {exc}") from exc
        segments = [
            {
                "text": str(segment.get("text", "")).strip(),
                "start_ms": int(segment.get("start_ms", 0)),
                "end_ms": int(segment.get("end_ms", 0)),
            }
            for segment in body.get("segments", [])
            if str(segment.get("text", "")).strip()
        ]
        return segments, body.get("language")


def _error_detail(exc: urllib.error.HTTPError) -> dict[str, Any]:
    try:
        payload = json.loads(exc.read().decode("utf-8"))
    except Exception:
        return {}
    detail = payload.get("detail", payload)
    return detail if isinstance(detail, dict) else {}
