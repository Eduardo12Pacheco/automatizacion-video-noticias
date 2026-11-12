from __future__ import annotations

from typing import Any

from subtitles_service.domain.style import (
    DEFAULT_ALIGN,
    DEFAULT_COLOR,
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    DEFAULT_MAX_WIDTH_PX,
    font_weight_for,
    sanitize_layout,
)


def normalize_segments_for_snapshot(raw_segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for index, segment in enumerate(raw_segments, start=1):
        style = dict(segment.get("style") or {})
        font_family = str(style.get("font_family") or segment.get("font_family") or DEFAULT_FONT_FAMILY)
        normalized_segment = {
            "id": str(segment.get("id") or segment.get("segment_id") or f"cue-{index}"),
            "start_ms": int(segment.get("start_ms") or segment.get("start") or 0),
            "end_ms": int(segment.get("end_ms") or segment.get("end") or 1),
            "source_text": str(segment.get("source_text") or segment.get("source_en") or ""),
            "translated_text": str(
                segment.get("translated_text") or segment.get("translated_es") or segment.get("text") or ""
            ).upper(),
            "style": {
                "align": str(style.get("align") or segment.get("align") or DEFAULT_ALIGN),
                "font_size": int(style.get("font_size") or segment.get("font_size") or DEFAULT_FONT_SIZE),
                "font_family": font_family,
                "font_weight": str(
                    style.get("font_weight") or segment.get("font_weight") or font_weight_for(font_family)
                ),
                "color": str(style.get("color") or segment.get("color") or DEFAULT_COLOR),
                "max_width_px": int(style.get("max_width_px") or segment.get("max_width_px") or DEFAULT_MAX_WIDTH_PX),
            },
        }
        layout = sanitize_layout(segment.get("layout") or style.get("layout"))
        if layout is not None:
            normalized_segment["layout"] = layout
        normalized.append(normalized_segment)
    return normalized
