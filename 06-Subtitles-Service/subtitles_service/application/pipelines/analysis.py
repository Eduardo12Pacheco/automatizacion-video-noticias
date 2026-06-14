from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from subtitles_service.domain.errors import ErrorCode, PipelineError


ProgressCallback = Callable[[int], None]


def _noop_progress(_pct: int) -> None:
    return None


def run_analysis_pipeline(
    session_dir: Path,
    source_video_path: Path,
    source_language: str,
    target_language: str,
    on_progress: ProgressCallback = _noop_progress,
) -> list[dict[str, Any]]:
    """Legacy signature: extract audio + transcribe + translate into segments.

    The real pipeline lives in `run_real_analysis_pipeline` below. This
    wrapper exists so legacy callers (e.g. legacy CLI) keep working.
    """
    return run_real_analysis_pipeline(
        source_video_path=source_video_path,
        source_language=source_language,
        target_language=target_language,
        on_progress=on_progress,
    )


def run_real_analysis_pipeline(
    source_video_path: Path,
    source_language: str,
    target_language: str,
    on_progress: ProgressCallback = _noop_progress,
) -> list[dict[str, Any]]:
    """End-to-end pipeline:

    1. ffmpeg extracts a mono 16 kHz wav from the uploaded video.
    2. faster-whisper transcribes the wav into timestamped segments
       and returns `(segments, info)` where `info.language` is the
       BCP-47 code Whisper actually used.
    3. Resolve the translator via the unified resolver:
       Marian (`opus-mt-XX-es`) for the 10 supported codes, M2M100
       for the 6 fallback codes, hard-fail otherwise. When the user
       picked `source_language="auto"`, use the language Whisper
       detected (normalized to ISO 639-1).
    4. Build segments carrying `text`, `source_text`, `translated_text`,
       `start_ms`, `end_ms`. The snapshot normalizer keeps both
       `source_text` and `translated_text` so the editor UI can show
       the original ASR text alongside the Spanish translation.

    `on_progress(pct)` is called at coarse checkpoints so the analyze
    job can surface real progress to the panel.
    """
    from subtitles_service.infrastructure.media.audio import (
        extract_audio_wav,
        read_wav_duration_ms,
    )
    from subtitles_service.infrastructure.asr.whisper_asr import (
        WhisperTranscriber,
        normalize_to_iso639_1,
    )
    from subtitles_service.infrastructure.translation import (
        SUPPORTED_SOURCE_LANGUAGES,
        resolve_translator_for_source,
    )

    on_progress(10)
    audio_path = extract_audio_wav(source_video_path, source_video_path.with_suffix(".wav"))
    duration_ms = read_wav_duration_ms(audio_path)
    on_progress(25)

    asr = WhisperTranscriber.default()
    raw_segments, asr_info = asr.transcribe(audio_path, language=source_language)
    if not raw_segments:
        on_progress(95)
        # Clean up the extracted wav regardless of outcome.
        try:
            audio_path.unlink(missing_ok=True)
        except OSError:
            pass
        return []

    on_progress(60)

    # --- Resolve the effective source language ---
    # If the user picked "auto", honor Whisper's detected language (normalized
    # to ISO 639-1 from BCP-47). Otherwise use what the user asked for.
    detected_language = normalize_to_iso639_1(asr_info.language)
    source_norm = (source_language or "").strip().lower()
    if source_norm == "auto":
        effective_source = detected_language
    else:
        effective_source = source_norm

    # Spanish (or already-target-language) inputs skip translation entirely.
    if effective_source in {target_language.lower(), "es", "es-es", "spanish"}:
        on_progress(85)
        segments: list[dict[str, Any]] = []
        for raw in raw_segments:
            segments.append(
                {
                    "text": raw["text"],
                    "translated_text": raw["text"],
                    "source_text": raw["text"],
                    "start_ms": int(raw["start_ms"]),
                    "end_ms": int(raw["end_ms"]),
                }
            )
        try:
            audio_path.unlink(missing_ok=True)
        except OSError:
            pass
        on_progress(95)
        return segments

    # If we resolved to "auto" because Whisper returned no language, fail
    # loudly with `UNSUPPORTED_DETECTED_LANGUAGE` — never fall back silently
    # to en-es.
    if not effective_source:
        try:
            audio_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise PipelineError(
            code=ErrorCode.UNSUPPORTED_DETECTED_LANGUAGE,
            message=(
                "Whisper could not detect the source language; the panel "
                "must pick an explicit source language."
            ),
            details={
                "supported": sorted(SUPPORTED_SOURCE_LANGUAGES),
                "detected_language": detected_language,
            },
        )

    if effective_source not in SUPPORTED_SOURCE_LANGUAGES:
        try:
            audio_path.unlink(missing_ok=True)
        except OSError:
            pass
        # Distinguish "user picked an unknown code" (UNSUPPORTED_SOURCE_LANGUAGE)
        # from "auto resolved to a code with no model" (UNSUPPORTED_DETECTED_LANGUAGE).
        if source_norm == "auto":
            raise PipelineError(
                code=ErrorCode.UNSUPPORTED_DETECTED_LANGUAGE,
                message=(
                    f"Whisper detected '{detected_language}' which has no "
                    f"Marian or M2M100 model."
                ),
                details={
                    "detected_language": detected_language,
                    "supported": sorted(SUPPORTED_SOURCE_LANGUAGES),
                },
            )
        raise PipelineError(
            code=ErrorCode.UNSUPPORTED_SOURCE_LANGUAGE,
            message=f"Unsupported source language: {source_language!r}",
            details={
                "received": source_language,
                "supported": sorted(SUPPORTED_SOURCE_LANGUAGES),
            },
        )

    translator = resolve_translator_for_source(
        effective_source, target=target_language
    )

    # Tag each segment with the source language so the M2M100 translator
    # (which needs the src lang at generate time) can read it from the
    # segment list. Marian ignores the key. We strip it before the snapshot
    # is persisted — it's a transient field.
    for seg in raw_segments:
        seg["__source_lang__"] = effective_source

    try:
        translated_segments = translator.translate(
            raw_segments, target=target_language
        )
    finally:
        # Always strip the transient key from the raw input even if the
        # translator mutated it (it shouldn't, but be defensive).
        for seg in raw_segments:
            seg.pop("__source_lang__", None)

    on_progress(85)

    segments = translated_segments

    # Clean up the extracted wav to keep the session dir tidy.
    try:
        audio_path.unlink(missing_ok=True)
    except OSError:
        pass

    on_progress(95)
    return segments


__all__ = [
    "run_analysis_pipeline",
    "run_real_analysis_pipeline",
    "ProgressCallback",
]
