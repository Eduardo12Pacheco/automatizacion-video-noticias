#!/usr/bin/env python3
"""Idempotent local model download for the CPU/GPU worker images."""
from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
VOICE_PATHS = {
    "en_US-lessac-medium": "en/en_US/lessac/medium/en_US-lessac-medium",
    "es_ES-davefx-medium": "es/es_ES/davefx/medium/es_ES-davefx-medium",
}
PIPER_SIZE_HINT = "~60 MB per voice"
WHISPER_SIZE_HINTS = {
    "tiny": "~75 MB",
    "base": "~145 MB",
    "small": "~480 MB",
    "medium": "~1.5 GB",
    "large-v3": "~3 GB",
}


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size > 0:
        print(f"model-init: present {target}")
        return
    tmp = target.with_suffix(target.suffix + ".part")
    print(f"model-init: downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as response, tmp.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    tmp.replace(target)


def init_piper() -> None:
    model = os.environ.get("PIPER_MODEL", "en_US-lessac-medium").strip()
    root = Path(os.environ.get("PIPER_MODEL_DIR", "/models/piper")) / model
    path = VOICE_PATHS.get(model)
    if not path:
        print(f"model-init: unknown Piper voice {model}; set PIPER_MODEL to a supported voice", file=sys.stderr)
        return
    print(f"model-init: Piper {model} ({PIPER_SIZE_HINT})")
    for suffix in (".onnx", ".onnx.json"):
        download(f"{PIPER_BASE}/{path}{suffix}", root / f"{model}{suffix}")


def init_whisper() -> None:
    model = os.environ.get("WHISPER_MODEL", "small").strip()
    root = Path(os.environ.get("WHISPER_MODEL_DIR", "/models/whisper")) / model
    if (root / "model.bin").is_file() and (root / "config.json").is_file():
        print(f"model-init: present {root}")
        return
    from huggingface_hub import snapshot_download

    print(f"model-init: Whisper {model} ({WHISPER_SIZE_HINTS.get(model, 'unknown size')})")
    snapshot_download(
        repo_id=f"Systran/faster-whisper-{model}",
        local_dir=str(root),
        allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.txt", "preprocessor_config.json"],
    )
    print(f"model-init: downloaded {root}")


def init_qwen_tts() -> None:
    """Download the GPU voice checkpoint only when the GPU engine is selected.

    The reference WAV/TXT shipped with the worker stay in the image; this is
    just the 1.7B model (~4.5 GB) that the Qwen engine loads from a local path.
    """
    engine = os.environ.get("TTS_WORKER_ENGINE", "piper").strip().lower()
    if engine != "qwen":
        print(f"model-init: Qwen TTS not selected (TTS_WORKER_ENGINE={engine})")
        return
    model = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base").strip()
    root = Path(os.environ.get("QWEN_TTS_MODEL_DIR", "/models/qwen-tts"))
    if (root / "model.safetensors").is_file():
        print(f"model-init: present {root}")
        return
    from huggingface_hub import snapshot_download

    print(f"model-init: Qwen TTS {model} (~4.5 GB)")
    snapshot_download(
        repo_id=model,
        local_dir=str(root),
        allow_patterns=["*.json", "*.txt", "*.safetensors", "speech_tokenizer/*"],
    )
    print(f"model-init: downloaded {root}")


if __name__ == "__main__":
    init_piper()
    init_whisper()
    init_qwen_tts()
    print("model-init: done")
