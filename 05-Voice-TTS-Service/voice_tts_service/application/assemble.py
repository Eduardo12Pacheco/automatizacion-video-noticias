from __future__ import annotations

from pathlib import Path
from typing import List

import numpy as np
import soundfile as sf

from voice_tts_service.domain.segmenter import Segment


def _trim_silence(audio: np.ndarray, sample_rate: int, *, threshold: float, min_silence_ms: int, trim_leading: bool, trim_trailing: bool) -> np.ndarray:
    if audio.size == 0:
        return audio
    idx = np.where(np.abs(audio) > threshold)[0]
    if idx.size == 0:
        return audio
    start = 0
    end = audio.size
    min_silence_samples = int((min_silence_ms / 1000.0) * sample_rate)
    if trim_leading and int(idx[0]) >= min_silence_samples:
        start = int(idx[0])
    if trim_trailing and int(audio.size - idx[-1] - 1) >= min_silence_samples:
        end = int(idx[-1] + 1)
    return audio[start:end]


def _silence(duration_ms: int, sample_rate: int) -> np.ndarray:
    n = int((duration_ms / 1000.0) * sample_rate)
    return np.zeros(max(0, n), dtype=np.float32)


def _apply_crossfade(left: np.ndarray, right: np.ndarray, sample_rate: int, crossfade_ms: int) -> np.ndarray:
    if left.size == 0:
        return right
    if right.size == 0:
        return left
    n = min(int((crossfade_ms / 1000.0) * sample_rate), left.shape[0], right.shape[0])
    if n <= 0:
        return np.concatenate([left, right])
    fade_out = np.linspace(1.0, 0.0, num=n, dtype=np.float32)
    fade_in = np.linspace(0.0, 1.0, num=n, dtype=np.float32)
    return np.concatenate([left[:-n], left[-n:] * fade_out + right[:n] * fade_in, right[n:]])


def assemble_segments(segments: List[Segment], segment_audio_paths: List[Path], output_path: Path, crossfade_ms: int, output_gain_db: float = 0.0, peak_protection: bool = True, peak_target: float = 0.99, trim_cfg: dict | None = None) -> tuple[Path, int]:
    if len(segments) != len(segment_audio_paths):
        raise ValueError("Cantidad de segmentos y archivos de audio no coincide.")
    final_audio = np.zeros(0, dtype=np.float32)
    sample_rate = None
    trim_cfg = trim_cfg or {}
    for segment, audio_path in zip(segments, segment_audio_paths):
        audio, sr = sf.read(str(audio_path), dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if bool(trim_cfg.get("enabled", False)):
            audio = _trim_silence(audio, sr, threshold=float(trim_cfg.get("threshold", 0.005)), min_silence_ms=int(trim_cfg.get("min_silence_ms", 180)), trim_leading=bool(trim_cfg.get("trim_leading", True)), trim_trailing=bool(trim_cfg.get("trim_trailing", True)))
        if sample_rate is None:
            sample_rate = sr
        elif sr != sample_rate:
            raise ValueError(f"Sample rate inconsistente en {audio_path}: {sr} vs {sample_rate}")
        final_audio = _apply_crossfade(final_audio, audio, sample_rate, crossfade_ms)
        final_audio = np.concatenate([final_audio, _silence(segment.pause_after_ms, sample_rate)])
    if output_gain_db != 0.0 and final_audio.size > 0:
        final_audio = final_audio * float(10 ** (output_gain_db / 20.0))
    if peak_protection and final_audio.size > 0:
        peak = float(np.max(np.abs(final_audio)))
        target = float(max(0.01, min(1.0, peak_target)))
        if peak > target:
            final_audio = final_audio * (target / peak)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output_path), final_audio, sample_rate)
    return output_path, int(sample_rate)
