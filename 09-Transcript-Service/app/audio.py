from __future__ import annotations

from pathlib import Path
import subprocess
from typing import Protocol

from .worker import DependencyFailure


class CommandRunner(Protocol):
    def __call__(self, command: list[str], **kwargs): ...



class FfmpegAudioExtractor:
    def __init__(self, *, binary: str = "ffmpeg", runner: CommandRunner | None = None, timeout_seconds: int = 1800):
        self.binary = binary
        self.runner = runner or self._run
        self.timeout_seconds = timeout_seconds

    @staticmethod
    def _run(command: list[str], **kwargs):
        return subprocess.run(command, capture_output=True, text=True, check=False, timeout=kwargs.get("timeout"))

    def _run_command(self, command: list[str]):
        try:
            return self.runner(command, timeout=self.timeout_seconds)
        except TypeError:
            return self.runner(command)
        except subprocess.TimeoutExpired as exc:
            raise DependencyFailure("ffmpeg_timeout", f"ffmpeg timed out after {self.timeout_seconds} seconds") from exc

    def extract_16khz_wav(self, source_path: Path, audio_dir: Path) -> Path:
        audio_dir.mkdir(parents=True, exist_ok=True)
        output = audio_dir / "audio-16khz.wav"
        command = [self.binary, "-y", "-i", str(source_path), "-ac", "1", "-ar", "16000", str(output)]
        try:
            completed = self._run_command(command)
        except FileNotFoundError as exc:
            raise DependencyFailure("ffmpeg_unavailable", f"ffmpeg binary not found: {self.binary}") from exc
        if getattr(completed, "returncode", 0) != 0:
            stderr = (getattr(completed, "stderr", "") or "ffmpeg failed").strip()
            raise DependencyFailure("ffmpeg_failed", stderr)
        if not output.exists():
            raise DependencyFailure("ffmpeg_no_output", "ffmpeg completed but did not create audio/audio-16khz.wav")
        return output
