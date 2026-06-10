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
    2. faster-whisper transcribes the wav into timestamped segments.
    3. MarianMT (opus-mt-XX-es) translates each segment to Spanish.
       If the source language is already Spanish, we skip translation.

    `on_progress(pct)` is called at coarse checkpoints so the analyze
    job can surface real progress to the panel.
    """
    from subtitles_service.infrastructure.media.audio import (
        extract_audio_wav,
        read_wav_duration_ms,
    )
    from subtitles_service.infrastructure.asr.whisper_asr import WhisperTranscriber
    from subtitles_service.infrastructure.translation.opus_mt import (
        resolve_translator_for_source,
    )

    on_progress(10)
    audio_path = extract_audio_wav(source_video_path, source_video_path.with_suffix(".wav"))
    duration_ms = read_wav_duration_ms(audio_path)
    on_progress(25)

    asr = WhisperTranscriber.default()
    raw_segments = asr.transcribe(audio_path, language=source_language)
    if not raw_segments:
        on_progress(95)
        # Clean up the extracted wav regardless of outcome.
        try:
            audio_path.unlink(missing_ok=True)
        except OSError:
            pass
        return []

    on_progress(60)

    # Skip translation when the source language is already the target. We
    # do a case-insensitive check on the configured codes.
    translated: list[str]
    if source_language.lower() in {target_language.lower(), "es", "es-es"}:
        translated = [seg["text"] for seg in raw_segments]
    else:
        translator = resolve_translator_for_source(source_language)
        translated = translator.translate_batch([seg["text"] for seg in raw_segments])

    on_progress(85)

    segments: list[dict[str, Any]] = []
    for raw, es in zip(raw_segments, translated):
        segments.append(
            {
                "text": raw["text"],
                "translated_text": es,
                "start_ms": int(raw["start_ms"]),
                "end_ms": int(raw["end_ms"]),
            }
        )

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
