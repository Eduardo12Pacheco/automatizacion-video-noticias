from __future__ import annotations

import importlib.util
import shutil
from typing import Any

from .settings import Settings


def collect_preflight_failures(runtime: dict[str, Any]) -> list[dict[str, str]]:
    failures: list[dict[str, str]] = []
    for dependency, detail in runtime.items():
        if isinstance(detail, dict) and detail.get("status") != "ok":
            failures.append(
                {
                    "code": "dependency_missing",
                    "dependency": dependency,
                    "message": f"Required dependency {dependency} is missing",
                }
            )
    return failures


class PreflightChecker:
    def __init__(self, settings: Settings):
        self.settings = settings

    def report(self) -> dict[str, Any]:
        ffmpeg_path = shutil.which(self.settings.ffmpeg_binary)
        has_faster_whisper = importlib.util.find_spec("faster_whisper") is not None
        faster_whisper = {
            "status": "ok" if has_faster_whisper else "missing",
            "model": self.settings.whisper_model,
            "model_path": self.settings.whisper_model_path,
            "device": self.settings.device,
            "compute_type": self.settings.compute_type,
        }
        yt_dlp_path = shutil.which(self.settings.yt_dlp_binary)
        return {
            "ffmpeg": {"status": "ok" if ffmpeg_path else "missing", "path": ffmpeg_path},
            "yt_dlp": {"status": "ok" if yt_dlp_path else "missing", "path": yt_dlp_path},
            "faster_whisper": faster_whisper,
        }
