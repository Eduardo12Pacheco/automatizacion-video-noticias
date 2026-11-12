from __future__ import annotations

import os
from pathlib import Path

from newsroom_worker_common.asr_client import AsrWorkerClient, AsrWorkerError

from subtitles_service.domain.errors import ErrorCode, PipelineError


class WhisperTranscriber:
    """Client for the single faster-whisper worker (`services/asr-worker`).

    The subtitles service used to load its own faster-whisper model. Whisper
    now lives in one place so the GPU slot, model cache and CPU fallback are
    shared with the transcript/radar service. `ASR_WORKER_URL` selects the
    worker (default `http://127.0.0.1:8765`).
    """

    def __init__(
        self,
        model_size_or_path: str | None = None,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        client: AsrWorkerClient | None = None,
    ) -> None:
        # Kept for callers that still pass SUBS_ASR_MODEL; the worker owns the
        # model name now.
        self.model_size_or_path = model_size_or_path
        self._client = client or AsrWorkerClient(
            base_url=base_url or os.getenv("ASR_WORKER_URL") or "http://127.0.0.1:8765",
            api_key=api_key if api_key is not None else os.getenv("TRANSCRIPT_SERVICE_API_KEY", ""),
            timeout_seconds=float(os.getenv("ASR_WORKER_TIMEOUT_SECONDS", "1800")),
        )

    @classmethod
    def default(cls) -> "WhisperTranscriber":
        return cls(model_size_or_path=os.getenv("SUBS_ASR_MODEL") or None)

    def transcribe(
        self,
        audio_path: Path,
        language: str | None = None,
    ) -> tuple[list[dict], "WhisperTranscribeInfo"]:
        try:
            segments, detected_language = self._client.transcribe(audio_path, language=language)
        except AsrWorkerError as exc:
            raise PipelineError(
                ErrorCode.ASR_FAILED,
                exc.message,
                {"provider": "asr-worker", "code": exc.code},
            ) from exc
        info_out = WhisperTranscribeInfo(language=str(detected_language or ""))
        return segments, info_out


def normalize_to_iso639_1(code: str | None) -> str:
    """Normalize a Whisper BCP-47 / underscore code to bare ISO 639-1.

    Examples:
        ``"fr-FR" -> "fr"``     BCP-47 regional form
        ``"pt_br" -> "pt"``     whisper sometimes uses underscores
        ``"" / None / "None" -> ""``
    """
    if code is None:
        return ""
    raw = str(code).strip()
    if not raw or raw.lower() == "none":
        return ""
    return raw.split("-")[0].split("_")[0].lower()


class WhisperTranscribeInfo:
    """Minimal shape for the info object `transcribe()` returns."""

    __slots__ = ("language",)

    def __init__(self, language: str = "") -> None:
        self.language = language

    def __repr__(self) -> str:
        return f"WhisperTranscribeInfo(language={self.language!r})"


__all__ = ["WhisperTranscriber", "WhisperTranscribeInfo", "normalize_to_iso639_1"]
