from __future__ import annotations

from pathlib import Path


def ensure_worker_runtime_dirs(runtime_dir: Path, input_dir: Path, output_dir: Path, segments_dir: Path) -> None:
    runtime_dir.mkdir(parents=True, exist_ok=True)
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    segments_dir.mkdir(parents=True, exist_ok=True)


def find_report(output_dir: Path, job_id: str) -> Path | None:
    matches = list(output_dir.glob(f"**/{job_id}.report.json"))
    if not matches:
        return None
    return sorted(matches)[-1]
