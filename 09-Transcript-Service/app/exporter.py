from __future__ import annotations

from collections import defaultdict

from .models import MentionMatch, TranscriptArtifact
from .store import format_timestamp


MAX_TRANSCRIPT_PARAGRAPH_MS = 30_000
MAX_TRANSCRIPT_PARAGRAPH_CHARS = 900


def build_summary(matches: list[MentionMatch]) -> dict[str, list[dict[str, object]]]:
    grouped: dict[tuple[str, str | None], list[MentionMatch]] = defaultdict(list)
    for match in matches:
        grouped[(match.canonical, match.country)].append(match)

    items = []
    for (canonical, country), group in sorted(grouped.items(), key=lambda item: (item[0][1] or "", item[0][0])):
        timestamps = [format_timestamp(match.start_ms) for match in group]
        variants = sorted({match.keyword for match in group})
        items.append(
            {
                "label": canonical,
                "country": country,
                "count": len(group),
                "timestamps": timestamps,
                "variants": variants,
            }
        )
    return {"items": items}


def build_export_text(
    *,
    title: str | None,
    selected_countries: list[str],
    detected_language: str | None,
    variants_used: dict[str, list[str]],
    summary: dict[str, object],
    transcript: TranscriptArtifact,
) -> str:
    lines = [
        "Instrucciones para GPT:",
        "Analizá esta transcripción como material de investigación futbolística. Respondé en español, citando timestamps cuando uses evidencia.",
        "",
        f"Título: {title or 'No disponible'}",
        f"Países seleccionados: {', '.join(selected_countries) if selected_countries else 'No especificados'}",
        f"Idioma detectado: {detected_language or 'desconocido'}",
        "",
        "Entidades y variantes seleccionadas:",
    ]
    for canonical, variants in sorted(variants_used.items()):
        lines.append(f"- {canonical}: {', '.join(variants)}")
    lines.extend(["", "Resumen determinístico:"])
    for item in summary.get("items", []):
        lines.append(
            f"- {item.get('label')}: {item.get('count')} menciones ({', '.join(item.get('timestamps', []))})"
        )
    lines.extend(["", "Transcripción completa:", format_transcript_paragraphs(transcript)])
    return "\n".join(lines).strip() + "\n"


def format_transcript_paragraphs(transcript: TranscriptArtifact) -> str:
    if not transcript.segments:
        return transcript.text.strip()

    paragraphs: list[str] = []
    current_start_ms: int | None = None
    current_end_ms = 0
    current_parts: list[str] = []

    def flush() -> None:
        nonlocal current_start_ms, current_end_ms, current_parts
        if current_start_ms is None or not current_parts:
            return
        text = " ".join(part.strip() for part in current_parts if part.strip())
        if text:
            paragraphs.append(f"({format_timestamp(current_start_ms)}) {text}")
        current_start_ms = None
        current_end_ms = 0
        current_parts = []

    for segment in transcript.segments:
        text = segment.text.strip()
        if not text:
            continue
        if current_start_ms is None:
            current_start_ms = segment.start_ms
        candidate = " ".join([*current_parts, text]).strip()
        elapsed_ms = segment.end_ms - current_start_ms
        gap_ms = segment.start_ms - current_end_ms if current_end_ms else 0
        should_flush = bool(current_parts) and (
            elapsed_ms > MAX_TRANSCRIPT_PARAGRAPH_MS
            or len(candidate) > MAX_TRANSCRIPT_PARAGRAPH_CHARS
            or gap_ms > 4_000
        )
        if should_flush:
            flush()
            current_start_ms = segment.start_ms
        current_parts.append(text)
        current_end_ms = segment.end_ms

    flush()
    return "\n\n".join(paragraphs)
