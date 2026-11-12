from __future__ import annotations

import json
import subprocess
import wave
from pathlib import Path

from subtitles_service.domain.errors import ErrorCode, PipelineError


def extract_audio_wav(source_video: Path, output_wav: Path) -> Path:
    """Extract a mono 16 kHz PCM wav from the uploaded video.

    16 kHz mono is the canonical faster-whisper input shape, so we
    decode + resample in one ffmpeg pass and skip per-call preprocessing
    inside the ASR wrapper.
    """
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", str(source_video),
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-f", "wav",
        str(output_wav),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as error:
        raise PipelineError(
            ErrorCode.ASR_FAILED,
            f"Could not launch ffmpeg to extract audio: {error}",
            {"executable": "ffmpeg"},
        ) from error
    if result.returncode != 0:
        raise PipelineError(
            ErrorCode.ASR_FAILED,
            "ffmpeg failed to extract audio from the uploaded video",
            {"stderr": result.stderr.strip(), "returncode": result.returncode},
        )
    if not output_wav.is_file() or output_wav.stat().st_size == 0:
        raise PipelineError(
            ErrorCode.ASR_FAILED,
            "ffmpeg produced an empty wav file (the video may have no audio track)",
            {"path": str(output_wav)},
        )
    return output_wav


def read_wav_duration_ms(wav_path: Path) -> int:
    """Read the duration of a wav file using stdlib only (no ffprobe)."""
    with wave.open(str(wav_path), "rb") as handle:
        frames = handle.getnframes()
        rate = handle.getframerate() or 1
    return int((frames / rate) * 1000)


def probe_first_dict(wav_path: Path) -> dict:
    """Best-effort dump of the wav header for diagnostics; not used in
    the hot path but handy when the panel needs to display duration_ms.
    """
    with wave.open(str(wav_path), "rb") as handle:
        return {
            "framerate": handle.getframerate(),
            "nframes": handle.getnframes(),
            "nchannels": handle.getnchannels(),
            "sampwidth": handle.getsampwidth(),
        }


__all__ = ["extract_audio_wav", "read_wav_duration_ms", "probe_first_dict"]
