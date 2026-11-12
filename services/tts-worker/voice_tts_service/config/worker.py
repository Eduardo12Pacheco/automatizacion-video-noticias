from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class WorkerConfig:
    project_root: Path
    runtime_dir: Path
    jobs_db: Path
    input_dir: Path
    output_dir: Path
    segments_dir: Path
    python_exec: str
    ref_audio_path: Path
    ref_text_path: Path
    config_yaml_path: Path
    internal_token: str
    queue_max: int
    job_timeout_sec: int
    preset: str | None
    device: str | None


def load_config() -> WorkerConfig:
    project_root = Path(__file__).resolve().parents[2]
    worker_root = project_root / "tts-worker"
    runtime_dir = Path(os.getenv("TTS_WORKER_RUNTIME_DIR", worker_root / "runtime")).resolve()
    preset = os.getenv("TTS_WORKER_PRESET", "").strip() or None
    device = os.getenv("TTS_WORKER_DEVICE", "").strip() or None
    return WorkerConfig(
        project_root=project_root,
        runtime_dir=runtime_dir,
        jobs_db=runtime_dir / "jobs.db",
        input_dir=runtime_dir / "inputs",
        output_dir=runtime_dir / "output",
        segments_dir=runtime_dir / "segments",
        python_exec=os.getenv("TTS_WORKER_PYTHON", sys.executable),
        ref_audio_path=Path(os.getenv("TTS_WORKER_REF_AUDIO", project_root / "refs" / "voz.wav")),
        ref_text_path=Path(os.getenv("TTS_WORKER_REF_TEXT", project_root / "refs" / "voz.txt")),
        config_yaml_path=Path(os.getenv("TTS_WORKER_CONFIG", project_root / "config" / "default.yaml")),
        internal_token=os.getenv("TTS_WORKER_INTERNAL_TOKEN", ""),
        queue_max=_env_int("TTS_WORKER_QUEUE_MAX", 20),
        job_timeout_sec=_env_int("TTS_WORKER_JOB_TIMEOUT_SEC", 1200),
        preset=preset,
        device=device,
    )
