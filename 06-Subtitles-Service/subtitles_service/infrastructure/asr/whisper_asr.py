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
    ) -> tuple[list[dict], "WhisperTranscribeInfo"]:
        """Run the ASR and return `(segments, info)`.

        `segments` is a list of `{text, start_ms, end_ms}` dicts (one per cue).

        `info` is a `WhisperTranscribeInfo` carrying at least `language`
        (the BCP-47 code Whisper used — e.g. `"fr-FR"` — or `""` if it
        could not detect). The analyze pipeline uses this to route
        `source_language="auto"` to the right translator.

        `language` accepts 'en', 'de', 'auto' (or None for whisper auto-detect).
        """
        model = self._load()
        try:
            # whisper auto-detects when language is None
            whisper_language = None if not language or language == "auto" else language
            segments_iter, info = model.transcribe(
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

        # `info.language` is BCP-47 (`fr-FR`, `en-US`, ...). Capture it so
        # the pipeline can route `auto` requests to the right translator.
        info_out = WhisperTranscribeInfo(
            language=str(getattr(info, "language", "") or ""),
        )
        return out, info_out


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
    """Minimal shape for the info object `transcribe()` returns.

    We avoid leaking the full `faster_whisper.TranscriptionInfo` to keep
    the analyze pipeline's contract small and stable across faster-whisper
    version bumps.
    """

    __slots__ = ("language",)

    def __init__(self, language: str = "") -> None:
        self.language = language

    def __repr__(self) -> str:
        return f"WhisperTranscribeInfo(language={self.language!r})"


__all__ = ["WhisperTranscriber", "WhisperTranscribeInfo", "normalize_to_iso639_1"]
