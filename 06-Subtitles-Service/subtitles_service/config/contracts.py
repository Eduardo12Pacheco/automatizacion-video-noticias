from __future__ import annotations

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT_DIR / "output"
MODELS_DIR = ROOT_DIR / "models"
DEFAULT_SHARED_MODELS_DIR = ROOT_DIR.parent / "local" / "models"


def _normalized_path(value: str | Path) -> Path:
    expanded = os.path.expandvars(os.path.expanduser(str(value)))
    return Path(expanded).resolve(strict=False)


def _path_from_env(env_name: str, default: Path) -> Path:
    raw_value = os.environ.get(env_name)
    if raw_value is None or raw_value.strip() == "":
        return _normalized_path(default)
    return _normalized_path(raw_value)


SHARED_MODELS_DIR = _path_from_env("SUBS_MODELS_DIR", DEFAULT_SHARED_MODELS_DIR)
ASR_MODEL_DIR = _path_from_env("SUBS_ASR_MODEL", SHARED_MODELS_DIR / "faster-whisper-large-v3")
TRANSLATION_MODEL_DIR = _path_from_env("SUBS_MT_EN_ES_MODEL", SHARED_MODELS_DIR / "opus-mt-en-es")

TRANSCRIPT_JSON_PATH = OUTPUT_DIR / "transcript.json"
TRANSLATION_JSON_PATH = OUTPUT_DIR / "translation.json"
SUBTITLES_JSON_PATH = OUTPUT_DIR / "subtitles.json"
EDITED_SUBTITLES_JSON_PATH = OUTPUT_DIR / "edited-subtitles.json"
RENDER_PROPS_JSON_PATH = OUTPUT_DIR / "render-props.json"
FINAL_VIDEO_PATH = OUTPUT_DIR / "video-final.mp4"

ALLOWED_INPUT_EXTENSIONS = {".mp4", ".mov"}
MAX_VIDEO_INPUT_BYTES = 1_073_741_824
ALLOWED_ALIGNMENTS = {"left"}

STYLE_DEFAULTS = {
    "font_family": "Khand",
    "font_weight": "Bold",
    "color": "#FFFFFF",
    "font_size": 110,
    "align": "left",
    "max_width_px": 1080,
}

POSITION_PRESETS = {"bottom": {"y": 920}}
DEFAULT_POSITION = "bottom"
FONT_SIZE_PRESETS = (90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140)
FONT_PALETTE = ("Khand", "Anton", "Impact", "League Gothic", "Oswald")
COLOR_PALETTE = ("#FFFFFF", "#FFF000", "#00FF5A", "#0CC3F2")
REQUIRED_SUBTITLE_KEYS = {"text", "timing", "style"}
REQUIRED_TIMING_KEYS = {"start_ms", "end_ms"}
