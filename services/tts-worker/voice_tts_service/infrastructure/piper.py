from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable

import soundfile as sf

from voice_tts_service.domain.segmenter import Segment


class PiperUnavailable(RuntimeError):
    pass


class PiperEngine:
    """CPU fallback engine backed by the Piper CLI.

    Piper is a small, permissively licensed neural TTS that runs on CPU, so it
    keeps the demo pipeline working on machines without CUDA. It does not clone
    a reference voice; `prepare_reference` only validates the configured model.
    """

    def __init__(
        self,
        generation_cfg: dict | None = None,
        device: str | None = None,
        *,
        binary: str | None = None,
        model_path: str | Path | None = None,
        runner: Callable[..., Any] | None = None,
    ):
        generation_cfg = generation_cfg or {}
        self.binary = binary or str(generation_cfg.get("piper_binary") or os.getenv("PIPER_BIN") or "piper")
        model = model_path or generation_cfg.get("piper_model") or os.getenv("PIPER_MODEL")
        self.model_path = Path(str(model)) if model else None
        self.length_scale = generation_cfg.get("piper_length_scale")
        self.noise_scale = generation_cfg.get("piper_noise_scale")
        self.device = "cpu"
        self._has_custom_runner = runner is not None
        self.runner = runner or subprocess.run

    def _require_model(self) -> Path:
        if self.model_path is None:
            raise PiperUnavailable(
                "Piper fallback is not configured: set PIPER_MODEL or generation.piper_model"
            )
        if not self.model_path.is_file():
            raise PiperUnavailable(f"Piper model not found: {self.model_path}")
        return self.model_path

    def prepare_reference(self, reference_audio_path: Path, reference_text: str) -> None:
        # Piper voices are fixed; the reference is not used for cloning.
        self._require_model()

    def _command(self, output_path: Path) -> list[str]:
        model_path = self._require_model()
        if not self._has_custom_runner and shutil.which(self.binary) is None and not Path(self.binary).is_file():
            raise PiperUnavailable(f"Piper binary not found: {self.binary}")
        command = [self.binary, "--model", str(model_path), "--output_file", str(output_path)]
        if self.length_scale is not None:
            command.extend(["--length_scale", str(self.length_scale)])
        if self.noise_scale is not None:
            command.extend(["--noise_scale", str(self.noise_scale)])
        return command

    def synthesize_to_file(self, segment: Segment, output_path: Path) -> int:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        command = self._command(output_path)
        completed = self.runner(
            command,
            input=str(segment.text),
            text=True,
            capture_output=True,
            check=False,
        )
        if int(getattr(completed, "returncode", 1)) != 0:
            detail = str(getattr(completed, "stderr", "") or getattr(completed, "stdout", "") or "")
            raise PiperUnavailable(f"Piper synthesis failed: {detail.strip()[:500]}")
        if not output_path.is_file():
            raise PiperUnavailable(f"Piper did not write an output file: {output_path}")
        _, sample_rate = sf.read(str(output_path), frames=1)
        return int(sample_rate)
