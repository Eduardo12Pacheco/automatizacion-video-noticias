from __future__ import annotations

from typing import Any

from subtitles_service.config.contracts import STYLE_DEFAULTS

DEFAULT_ALIGN = str(STYLE_DEFAULTS["align"])
DEFAULT_FONT_SIZE = int(STYLE_DEFAULTS["font_size"])
DEFAULT_FONT_FAMILY = str(STYLE_DEFAULTS["font_family"])
DEFAULT_FONT_WEIGHT = str(STYLE_DEFAULTS["font_weight"])
DEFAULT_COLOR = str(STYLE_DEFAULTS["color"])
DEFAULT_MAX_WIDTH_PX = int(STYLE_DEFAULTS["max_width_px"])
ALIGN_LEFT_PX = {"left": 125, "center": 420, "right": 735}


def normalize_align(raw_align: object) -> str:
    align = str(raw_align or DEFAULT_ALIGN).strip().lower()
    return align if align in {"left", "center", "right"} else DEFAULT_ALIGN


def normalize_font_size(raw_font_size: object) -> int:
    try:
        font_size = int(raw_font_size)
    except (TypeError, ValueError):
        return DEFAULT_FONT_SIZE
    return font_size if font_size > 0 else DEFAULT_FONT_SIZE


def normalize_font_family(raw_font_family: object) -> str:
    font_family = str(raw_font_family or DEFAULT_FONT_FAMILY).strip()
    return font_family or DEFAULT_FONT_FAMILY


def normalize_color(raw_color: object) -> str:
    color = str(raw_color or DEFAULT_COLOR).strip()
    return color or DEFAULT_COLOR


def normalize_max_width_px(raw_max_width_px: object) -> int:
    try:
        max_width_px = int(raw_max_width_px)
    except (TypeError, ValueError):
        return DEFAULT_MAX_WIDTH_PX
    return max_width_px if max_width_px > 0 else DEFAULT_MAX_WIDTH_PX


def font_weight_for(font_family: str) -> str:
    if font_family == DEFAULT_FONT_FAMILY:
        return DEFAULT_FONT_WEIGHT
    return "700" if font_family == "Oswald" else "normal"


def left_px_for_align(align: str) -> int:
    return int(ALIGN_LEFT_PX.get(align, ALIGN_LEFT_PX[DEFAULT_ALIGN]))


def build_editor_rows_from_transcript_and_translation(
    transcript: list[dict[str, Any]],
    translated: list[dict[str, Any]],
    effective_source_lang: str,
    target_lang: str,
) -> list[dict[str, Any]]:
    rows = []
    for index, segment in enumerate(translated, start=1):
        rows.append(
            {
                "id": f"cue-{index}",
                "start_ms": int(segment["start_ms"]),
                "end_ms": int(segment["end_ms"]),
                "source_en": str(transcript[index - 1]["text"]),
                "translated_es": str(segment["text"]).upper(),
                "align": DEFAULT_ALIGN,
                "font_size": DEFAULT_FONT_SIZE,
                "font_family": DEFAULT_FONT_FAMILY,
                "color": DEFAULT_COLOR,
                "max_width_px": DEFAULT_MAX_WIDTH_PX,
                "source_lang": effective_source_lang,
                "target_lang": target_lang,
            }
        )
    return rows


def sanitize_layout(raw_layout: object) -> dict[str, Any] | None:
    if not isinstance(raw_layout, dict):
        return None
    raw_lines = raw_layout.get("lines")
    if not isinstance(raw_lines, list):
        return None
    lines = [line.strip() for line in raw_lines if isinstance(line, str) and line.strip()]
    if not lines:
        return None
    layout: dict[str, Any] = {"lines": lines}
    source = raw_layout.get("source")
    if isinstance(source, str) and source.strip():
        layout["source"] = source.strip()
    return layout


def coerce_editor_row(raw_row: dict[str, Any]) -> dict[str, Any]:
    style = dict(raw_row.get("style") or {})
    row = {
        "id": str(raw_row.get("id") or raw_row.get("segment_id") or "cue-1"),
        "start_ms": int(raw_row.get("start_ms") or raw_row.get("start") or 0),
        "end_ms": int(raw_row.get("end_ms") or raw_row.get("end") or 1),
        "translated_es": str(raw_row.get("translated_es") or raw_row.get("translated_text") or raw_row.get("text") or ""),
        "align": style.get("align") or raw_row.get("align") or DEFAULT_ALIGN,
        "font_size": style.get("font_size") or raw_row.get("font_size") or DEFAULT_FONT_SIZE,
        "font_family": style.get("font_family") or raw_row.get("font_family") or DEFAULT_FONT_FAMILY,
        "color": style.get("color") or raw_row.get("color") or DEFAULT_COLOR,
        "max_width_px": style.get("max_width_px") or raw_row.get("max_width_px") or DEFAULT_MAX_WIDTH_PX,
    }
    layout = sanitize_layout(raw_row.get("layout") or style.get("layout"))
    if layout is not None:
        row["layout"] = layout
    stripe_enabled = style.get("stripe_enabled")
    if stripe_enabled is None:
        stripe_enabled = raw_row.get("stripe_enabled")
    if stripe_enabled is not None:
        row["stripe_enabled"] = bool(stripe_enabled)
    return row


def build_render_subtitles_payload(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    subtitles = []
    for raw_row in rows:
        row = coerce_editor_row(raw_row)
        align = normalize_align(row.get("align"))
        font_size = normalize_font_size(row.get("font_size"))
        font_family = normalize_font_family(row.get("font_family"))
        color = normalize_color(row.get("color"))
        max_width_px = normalize_max_width_px(row.get("max_width_px"))
        subtitle = {
            "text": str(row.get("translated_es") or "").upper(),
            "timing": {
                "start_ms": int(row.get("start_ms") or 0),
                "end_ms": int(row.get("end_ms") or 1),
            },
            "style": {
                "font_family": font_family,
                "font_weight": font_weight_for(font_family),
                "color": color,
                "font_size": font_size,
                "align": align,
                "left_px": left_px_for_align(align),
                "max_width_px": max_width_px,
                "stripe_enabled": bool(row.get("stripe_enabled", True)),
            },
        }
        layout = sanitize_layout(row.get("layout"))
        if layout is not None:
            subtitle["layout"] = layout
        subtitles.append(subtitle)
    return subtitles
