#!/usr/bin/env python3
"""Idempotent, checksum-verified local model download for the worker images.

Every file is pinned to a Hugging Face revision and its SHA-256 is recorded in
`model-manifest.json`. A download that does not match the manifest fails
loudly; an already-present file is verified again instead of trusted by size.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path

MANIFEST_PATH = Path(__file__).with_name("model-manifest.json")
HF_BASE = "https://huggingface.co"
PIPER_SIZE_HINT = "~60 MB per voice"
WHISPER_SIZE_HINTS = {
    "tiny": "~75 MB",
    "base": "~145 MB",
    "small": "~480 MB",
    "medium": "~1.5 GB",
    "large-v3": "~3 GB",
}


def load_manifest() -> dict:
    with MANIFEST_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def verify_file(path: Path, expected_sha256: str, label: str) -> bool:
    if not path.is_file() or path.stat().st_size == 0:
        return False
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise RuntimeError(f"model-init: checksum mismatch for {label}: expected {expected_sha256}, got {actual}")
    print(f"model-init: present {path}")
    return True


def download(url: str, target: Path, expected_sha256: str, expected_size: int | None = None) -> None:
    if verify_file(target, expected_sha256, target.name):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    print(f"model-init: downloading {url}")
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(url, timeout=120) as response, part.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
            handle.write(chunk)
    actual = digest.hexdigest()
    if expected_size is not None and size != expected_size:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"model-init: size mismatch for {target.name}: expected {expected_size}, got {size}")
    if actual != expected_sha256:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"model-init: checksum mismatch for {target.name}: expected {expected_sha256}, got {actual}")
    part.replace(target)


def url_for(repo: str, revision: str, path: str) -> str:
    return f"{HF_BASE}/{repo}/resolve/{revision}/{path}"


def init_piper(manifest: dict) -> None:
    model = os.environ.get("PIPER_MODEL", "es_ES-davefx-medium").strip()
    root = Path(os.environ.get("PIPER_MODEL_DIR", "/models/piper")) / model
    entry = manifest["piper"]["voices"].get(model)
    if not entry:
        raise RuntimeError(f"model-init: unknown Piper voice {model}; supported: {', '.join(sorted(manifest['piper']['voices']))}")
    print(f"model-init: Piper {model} ({PIPER_SIZE_HINT})")
    revision = manifest["piper"]["revision"]
    for file in entry["files"]:
        target = root / Path(file["path"]).name
        download(
            url_for(manifest["piper"]["repo"], revision, file["path"]),
            target,
            file["sha256"],
            file.get("size"),
        )


def download_snapshot(repo: str, revision: str, root: Path, files: list[dict]) -> None:
    """Download the manifest file list at a pinned revision, then verify it."""
    from huggingface_hub import snapshot_download

    if all(verify_file(root / file["path"], file["sha256"], file["path"]) for file in files):
        return
    snapshot_download(
        repo_id=repo,
        revision=revision,
        local_dir=str(root),
        allow_patterns=[file["path"] for file in files],
    )
    for file in files:
        target = root / file["path"]
        if not verify_file(target, file["sha256"], file["path"]):
            raise RuntimeError(f"model-init: downloaded file is missing: {target}")


def init_whisper(manifest: dict) -> None:
    model = os.environ.get("WHISPER_MODEL", "small").strip()
    entry = manifest["whisper"].get(model)
    if not entry:
        raise RuntimeError(f"model-init: unknown Whisper model {model}; supported: {', '.join(sorted(manifest['whisper']))}")
    root = Path(os.environ.get("WHISPER_MODEL_DIR", "/models/whisper")) / model
    print(f"model-init: Whisper {model} ({WHISPER_SIZE_HINTS.get(model, 'unknown size')})")
    download_snapshot(entry["repo"], entry["revision"], root, entry["files"])
    print(f"model-init: verified {root}")


def init_qwen_tts(manifest: dict) -> None:
    """Download the GPU voice checkpoint only when the GPU engine is selected."""
    engine = os.environ.get("TTS_WORKER_ENGINE", "piper").strip().lower()
    if engine != "qwen":
        print(f"model-init: Qwen TTS not selected (TTS_WORKER_ENGINE={engine})")
        return
    entry = manifest["qwenTts"]
    root = Path(os.environ.get("QWEN_TTS_MODEL_DIR", "/models/qwen-tts"))
    print(f"model-init: Qwen TTS {entry['repo']} (~4.5 GB)")
    download_snapshot(entry["repo"], entry["revision"], root, entry["files"])
    print(f"model-init: verified {root}")


def main() -> int:
    manifest = load_manifest()
    init_piper(manifest)
    init_whisper(manifest)
    init_qwen_tts(manifest)
    print("model-init: done")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as error:
        print(f"model-init: ERROR: {error}", file=sys.stderr)
        sys.exit(1)
