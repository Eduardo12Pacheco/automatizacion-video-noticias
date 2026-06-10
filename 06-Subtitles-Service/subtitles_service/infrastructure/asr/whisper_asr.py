from __future__ import annotations

import threading
from pathlib import Path
from typing import Iterable, Protocol

from subtitles_service.domain.errors import ErrorCode, PipelineError


class ASRSegmentLike(Protocol):
    text: str
    start: float
    end: float


class WhisperTranscriber:
    """Lazy wrapper around faster_whisper. The model is heavy to load, so we
    defer it to the first call and reuse it across the worker lifetime.

    `model_size_or_path` defaults to the SUBS_ASR_MODEL env var so the
    operator can swap between faster-whisper-large-v3, the turbo variant,
    or whisper-tiny without code changes.
    """

    _LOCK = threading.Lock()
    _INSTANCE: "WhisperTranscriber | None" = None

    def __init__(self, model_size_or_path: str) -> None:
        self.model_size_or_path = model_size_or_path
        self._model = None

    @classmethod
    def default(cls) -> "WhisperTranscriber":
        import os
        from subtitles_service.config.contracts import ASR_MODEL_DIR
        return cls(model_size_or_path=os.getenv("SUBS_ASR_MODEL") or str(ASR_MODEL_DIR))

    def _load(self):
        if self._model is None:
            with self._LOCK:
                if self._model is None:
                    try:
                        from faster_whisper import WhisperModel
                    except ImportError as exc:
                        raise PipelineError(
                            ErrorCode.MODEL_NOT_AVAILABLE,
                            "faster-whisper is not installed",
                            {"hint": "pip install faster-whisper"},
                        ) from exc
                    try:
                        self._model = WhisperModel(
                            self.model_size_or_path,
                            device="auto",
                            compute_type="auto",
                        )
                    except Exception as exc:
                        raise PipelineError(
                            ErrorCode.MODEL_NOT_AVAILABLE,
                            f"Could not load ASR model '{self.model_size_or_path}': {exc}",
                            {"model": self.model_size_or_path},
                        ) from exc
        return self._model

    def transcribe(
        self,
        audio_path: Path,
        language: str | None = None,
    ) -> list[dict]:
        """Run the ASR and return a list of {text, start_ms, end_ms} dicts.

        `language` accepts 'en', 'de', 'auto' (or None for whisper auto-detect).
        """
        model = self._load()
        try:
            # whisper auto-detects when language is None
            whisper_language = None if not language or language == "auto" else language
            segments_iter, _info = model.transcribe(
                str(audio_path),
                language=whisper_language,
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=False,
            )
        except Exception as exc:
            raise PipelineError(
                ErrorCode.ASR_FAILED,
                f"Whisper transcription failed: {exc}",
            ) from exc

        out: list[dict] = []
        for seg in segments_iter:
            text = (getattr(seg, "text", "") or "").strip()
            if not text:
                continue
            out.append(
                {
                    "text": text,
                    "start_ms": int(round(float(seg.start) * 1000)),
                    "end_ms": int(round(float(seg.end) * 1000)),
                }
            )
        return out


__all__ = ["WhisperTranscriber"]
