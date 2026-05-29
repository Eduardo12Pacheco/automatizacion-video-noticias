from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

from .models import TranscriptSegment
from .settings import Settings
from .worker import DependencyFailure, normalize_language


class FasterWhisperTranscriber:
    def __init__(self, *, settings: Settings, model_factory: Callable[..., Any] | None = None):
        self.settings = settings
        self.model_factory = model_factory or self._default_model_factory
        self._model: Any | None = None

    @staticmethod
    def _default_model_factory(model: str, *, device: str, compute_type: str):
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise DependencyFailure("faster_whisper_unavailable", "faster-whisper is not installed") from exc
        return WhisperModel(model, device=device, compute_type=compute_type)

    @staticmethod
    def _safe_error_message(exc: Exception) -> str:
        message = str(exc).strip()
        detail = f"{type(exc).__name__}: {message}" if message else type(exc).__name__
        for name, value in os.environ.items():
            if not value or len(value) < 8:
                continue
            if any(token in name.upper() for token in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
                detail = detail.replace(value, "[redacted]")
        return detail[:1000]

    def _model_instance(self):
        if self._model is None:
            self._model = self.model_factory(
                self.settings.whisper_model_source,
                device=self.settings.device,
                compute_type=self.settings.compute_type,
            )
        return self._model

    def transcribe(self, audio_path: Path) -> tuple[list[TranscriptSegment], str | None]:
        try:
            raw_segments, info = self._model_instance().transcribe(str(audio_path))
        except DependencyFailure:
            raise
        except Exception as exc:
            raise DependencyFailure("faster_whisper_failed", self._safe_error_message(exc)) from exc
        segments = [
            TranscriptSegment(
                id=f"seg-{index}",
                start_ms=int(round(segment.start * 1000)),
                end_ms=int(round(segment.end * 1000)),
                text=segment.text.strip(),
            )
            for index, segment in enumerate(raw_segments, start=1)
        ]
        return segments, normalize_language(getattr(info, "language", None))
