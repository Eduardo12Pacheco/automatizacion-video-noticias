from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

from newsroom_worker_common.gpu_slot import GpuSlot, GpuSlotTimeout

from .models import TranscriptSegment
from .settings import Settings
from .worker import DependencyFailure, normalize_language


class FasterWhisperTranscriber:
    def __init__(
        self,
        *,
        settings: Settings,
        model_factory: Callable[..., Any] | None = None,
        gpu_slot: GpuSlot | None = None,
    ):
        self.settings = settings
        self.model_factory = model_factory or self._default_model_factory
        self.gpu_slot = gpu_slot or GpuSlot(
            path=settings.gpu_lock_path,
            timeout_seconds=settings.gpu_lock_timeout_seconds,
            owner="asr-worker",
        )
        self._model: Any | None = None
        self._model_signature: tuple[str, str, str] | None = None
        self.device = settings.device
        self.compute_type = settings.compute_type
        self.fallback_used = False

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

    def _load(self, *, model: str, device: str, compute_type: str):
        signature = (model, device, compute_type)
        if self._model is None or self._model_signature != signature:
            self._model = self.model_factory(model, device=device, compute_type=compute_type)
            self._model_signature = signature
        return self._model

    def _model_instance(self):
        try:
            return self._load(
                model=self.settings.whisper_model_source,
                device=self.settings.device,
                compute_type=self.settings.compute_type,
            )
        except DependencyFailure:
            raise
        except Exception as exc:
            if not self._should_fallback_to_cpu():
                raise DependencyFailure("faster_whisper_failed", self._safe_error_message(exc)) from exc
            self.fallback_used = True
            self.device = "cpu"
            self.compute_type = self.settings.cpu_fallback_compute_type
            try:
                return self._load(
                    model=self.settings.cpu_fallback_model,
                    device="cpu",
                    compute_type=self.settings.cpu_fallback_compute_type,
                )
            except DependencyFailure:
                raise
            except Exception as fallback_exc:
                raise DependencyFailure(
                    "faster_whisper_failed",
                    self._safe_error_message(fallback_exc),
                ) from fallback_exc

    def _should_fallback_to_cpu(self) -> bool:
        return bool(self.settings.cpu_fallback) and str(self.settings.device).strip().lower() != "cpu"

    def transcribe(self, audio_path: Path) -> tuple[list[TranscriptSegment], str | None]:
        try:
            self.gpu_slot.acquire()
        except GpuSlotTimeout as exc:
            raise DependencyFailure("gpu_busy", str(exc)) from exc
        try:
            model = self._model_instance()
            try:
                raw_segments, info = model.transcribe(str(audio_path))
            except Exception as exc:
                raise DependencyFailure("faster_whisper_failed", self._safe_error_message(exc)) from exc
        finally:
            self.gpu_slot.release()
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
