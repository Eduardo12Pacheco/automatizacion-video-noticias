from __future__ import annotations

import re
import unicodedata

from .catalog import expand_catalog
from .models import MentionMatch, TargetProfile, TranscriptSegment


TARGET_PROFILES: dict[str, TargetProfile] = {
    "valdoria": TargetProfile(type="country", name="Valdoria", aliases=["valdoria", "seleccion valdoriana"]),
    "montelia": TargetProfile(type="country", name="Montelia", aliases=["seleccion montelia", "montelios"]),
    "rivamar": TargetProfile(type="country", name="Rivamar", aliases=["rivamarense", "seleccion rivamarense"]),
    "bosquemar": TargetProfile(type="country", name="Bosquemar", aliases=["bosquemarense", "seleccion bosquemarense"]),
    "terramar": TargetProfile(type="country", name="Terramar", aliases=["terramarense", "seleccion terramarense"]),
    "leonel marquez": TargetProfile(type="player", name="Leonel Márquez", aliases=["marquez", "leo marquez"]),
    "luis cardenas": TargetProfile(type="player", name="Luis Cárdenas", aliases=["lucho cardenas", "cardenas"]),
}


def normalize_text(value: str) -> str:
    without_marks = "".join(
        char for char in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(char)
    )
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]+", " ", without_marks)).strip()


def _terms_for(target: TargetProfile, extra_keywords: list[str]) -> list[tuple[str, str]]:
    profile = TARGET_PROFILES.get(normalize_text(target.name), target)
    target_terms = [profile.name, *profile.aliases, target.name, *target.aliases]
    pairs = [(normalize_text(term), profile.name) for term in target_terms if normalize_text(term)]
    pairs.extend((normalize_text(keyword), normalize_text(keyword)) for keyword in extra_keywords if normalize_text(keyword))

    seen: set[tuple[str, str]] = set()
    unique: list[tuple[str, str]] = []
    for keyword, canonical in pairs:
        pair = (keyword, canonical)
        if pair not in seen:
            seen.add(pair)
            unique.append(pair)
    return sorted(unique, key=lambda pair: len(pair[0]), reverse=True)


def _country_terms(countries: list[str], detected_language: str | None, extra_keywords: list[str]) -> list[tuple[str, str, str | None]]:
    pairs: list[tuple[str, str, str | None]] = []
    for entry in expand_catalog(countries, detected_language):
        pairs.extend((normalize_text(variant), entry.canonical, entry.country) for variant in entry.variants if normalize_text(variant))
    pairs.extend((normalize_text(keyword), normalize_text(keyword), None) for keyword in extra_keywords if normalize_text(keyword))

    seen: set[tuple[str, str, str | None]] = set()
    unique: list[tuple[str, str, str | None]] = []
    for pair in pairs:
        if pair not in seen:
            seen.add(pair)
            unique.append(pair)
    return sorted(unique, key=lambda pair: len(pair[0]), reverse=True)


def _overlaps(span: tuple[int, int], occupied: list[tuple[int, int]]) -> bool:
    return any(span[0] < used[1] and used[0] < span[1] for used in occupied)


def find_mentions(
    segments: list[TranscriptSegment], *, target: TargetProfile | None = None, countries: list[str] | None = None, detected_language: str | None = None, extra_keywords: list[str]
) -> list[MentionMatch]:
    if countries:
        terms = _country_terms(countries, detected_language, extra_keywords)
    elif target:
        terms = [(keyword, canonical, None) for keyword, canonical in _terms_for(target, extra_keywords)]
    else:
        terms = [(normalize_text(keyword), normalize_text(keyword), None) for keyword in extra_keywords if normalize_text(keyword)]
    matches: list[MentionMatch] = []

    for index, segment in enumerate(segments):
        normalized = normalize_text(segment.text)
        occupied: list[tuple[int, int]] = []
        segment_matches: list[tuple[int, MentionMatch]] = []
        for keyword, canonical, country in terms:
            pattern = re.compile(rf"(?<!\w){re.escape(keyword)}(?!\w)")
            for found in pattern.finditer(normalized):
                span = found.span()
                if _overlaps(span, occupied):
                    continue
                occupied.append(span)
                segment_matches.append(
                    (
                        span[0],
                        MentionMatch(
                             keyword=keyword,
                             canonical=canonical,
                            country=country,
                            segment_id=segment.id,
                            start_ms=segment.start_ms,
                            end_ms=segment.end_ms,
                            text=segment.text,
                            context_before=segments[index - 1].text if index > 0 else None,
                            context_after=segments[index + 1].text if index + 1 < len(segments) else None,
                        ),
                    )
                )
        matches.extend(match for _, match in sorted(segment_matches, key=lambda item: item[0]))
    return matches
