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
    "es_ES-demo-medium": "es/es_ES/demo/medium/es_ES-demo-medium",
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
    for suffix in (".onnx", ".onnx.json"):
        download(f"{PIPER_BASE}/{path}{suffix}", root / f"{model}{suffix}")


def init_whisper() -> None:
    model = os.environ.get("WHISPER_MODEL", "small").strip()
    root = Path(os.environ.get("WHISPER_MODEL_DIR", "/models/whisper")) / model
    if (root / "model.bin").is_file() and (root / "config.json").is_file():
        print(f"model-init: present {root}")
        return
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=f"Systran/faster-whisper-{model}",
        local_dir=str(root),
        allow_patterns=["config.json", "model.bin", "tokenizer.json", "vocabulary.txt", "preprocessor_config.json"],
    )
    print(f"model-init: downloaded {root}")


if __name__ == "__main__":
    init_piper()
    init_whisper()
    print("model-init: done")
