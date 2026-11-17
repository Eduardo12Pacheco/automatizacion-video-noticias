from __future__ import annotations

ALLOWED_PRESETS = {"balanced_default", "golazo_emotivo", "golazo_informativo", "default"}


def resolve_voice_profile(value: str | None) -> str:
    requested = (value or "").strip() or "balanced_default"
    if requested not in ALLOWED_PRESETS:
        raise ValueError("Invalid voice_profile.")
    return "balanced_default" if requested == "default" else requested
