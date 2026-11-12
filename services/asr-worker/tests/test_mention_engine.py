from __future__ import annotations

import json
from pathlib import Path

from app.catalog import expand_catalog, get_catalog_summary
from app.mention_engine import find_mentions, normalize_text
from app.models import TargetProfile, TranscriptSegment


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def test_mention_engine_matches_profile_aliases_case_and_diacritics_with_segment_timestamps():
    segments = [
        TranscriptSegment(id="s1", start_ms=5000, end_ms=9000, text="La seleccion Montelia presiona."),
        TranscriptSegment(id="s2", start_ms=12000, end_ms=15000, text="Café sin fútbol."),
    ]
    target = TargetProfile(type="country", name="Montelia", aliases=["Selección Montelia"])

    matches = find_mentions(segments, target=target, extra_keywords=["cafe"])

    assert [(m.keyword, m.canonical, m.segment_id, m.start_ms, m.end_ms) for m in matches] == [
        ("seleccion montelia", "Montelia", "s1", 5000, 9000),
        ("cafe", "cafe", "s2", 12000, 15000),
    ]
    assert normalize_text("Selección CAFÉ") == "seleccion cafe"


def test_mention_engine_prefers_longer_overlapping_terms_and_preserves_no_match_empty_list():
    segments = [TranscriptSegment(id="s1", start_ms=7000, end_ms=10000, text="Luis Cárdenas y Cárdenas aparecen.")]
    target = TargetProfile(type="player", name="Luis Cárdenas", aliases=["Cárdenas"])

    matches = find_mentions(segments, target=target, extra_keywords=[])

    assert [(m.keyword, m.segment_id, m.text) for m in matches] == [
        ("luis cardenas", "s1", "Luis Cárdenas y Cárdenas aparecen."),
        ("cardenas", "s1", "Luis Cárdenas y Cárdenas aparecen."),
    ]

    no_matches = find_mentions(
        [TranscriptSegment(id="s2", start_ms=11000, end_ms=13000, text="Sin nombres propios.")],
        target=target,
        extra_keywords=["valdoria"],
    )
    assert no_matches == []


def test_catalog_expands_selected_country_variants_for_supported_languages():
    catalog = get_catalog_summary()

    assert [country["code"] for country in catalog["countries"]] == [
        "aurenia",
        "montelia",
        "valdoria",
        "rivamar",
        "bosquemar",
        "terramar",
    ]

    expanded = expand_catalog(["montelia", "aurenia", "valdoria"], "fr")
    variants = {entry.canonical: entry.variants for entry in expanded}

    assert "Jaime Rueda" in variants
    assert "Jaime Rueda" in variants["Jaime Rueda"]
    assert "Nicolás Andrade" in variants
    assert "Nicolás Andrade" in variants["Nicolás Andrade"]
    assert "Leonel Márquez" in variants
    assert "Leonel Márquez" in variants["Leonel Márquez"]


def test_catalog_expands_nl_and_asr_aliases_into_spanish_canonical_entities():
    expanded = expand_catalog(["rivamar", "bosquemar", "terramar"], "nl")
    variants = {entry.canonical: entry.variants for entry in expanded}

    assert "Rivamar" in variants
    assert "Rivamar" in variants["Rivamar"]
    assert "Miguel Almada" in variants
    assert "Miguel Almada" in variants["Miguel Almada"]
    assert "Terramar" in variants
    assert "Terramar" in variants["Terramar"]


def test_catalog_unknown_language_falls_back_to_base_names_and_surnames_only():
    expanded = expand_catalog(["montelia"], "ja")

    player = next(entry for entry in expanded if entry.canonical == "Jaime Rueda")

    assert player.variants == ["Jaime Rueda", "Rueda"]


def test_mention_engine_matches_country_catalog_variants_with_selected_country_metadata():
    segments = [TranscriptSegment(id="s1", start_ms=12000, end_ms=18000, text="Jaime Rueda maneja a Montelia.")]

    matches = find_mentions(segments, countries=["montelia"], detected_language="fr", extra_keywords=["bloque alto"])

    assert [(m.keyword, m.canonical, m.country, m.segment_id, m.start_ms) for m in matches] == [
        ("jaime rueda", "Jaime Rueda", "montelia", "s1", 12000),
        ("montelia", "Montelia", "montelia", "s1", 12000),
    ]


def test_known_positive_mention_fixture_detects_expected_target_mention():
    fixture = json.loads((FIXTURES_DIR / "known_positive_mention.json").read_text(encoding="utf-8"))
    target = TargetProfile(**fixture["target"])
    segments = [TranscriptSegment(**segment) for segment in fixture["segments"]]

    matches = find_mentions(segments, target=target, extra_keywords=fixture["extra_keywords"])

    assert [
        {
            "keyword": match.keyword,
            "canonical": match.canonical,
            "segment_id": match.segment_id,
            "start_ms": match.start_ms,
            "end_ms": match.end_ms,
            "text": match.text,
        }
        for match in matches
    ] == fixture["expected_matches"]


def test_mention_engine_counts_multilingual_variants_to_spanish_canonical_labels():
    segments = [
        TranscriptSegment(id="s1", start_ms=5000, end_ms=9000, text="Pachio domina para Aurénie."),
        TranscriptSegment(id="s2", start_ms=11000, end_ms=14000, text="Terramar espera a Santi Gil."),
    ]

    matches = find_mentions(segments, countries=["aurenia", "terramar"], detected_language="fr", extra_keywords=[])

    assert [(m.keyword, m.canonical, m.country, m.start_ms) for m in matches] == [
        ("pachio", "Iván Cordero", "aurenia", 5000),
        ("aurenie", "Aurenia", "aurenia", 5000),
        ("terramar", "Terramar", "terramar", 11000),
        ("santi gil", "Santiago Gil", "terramar", 11000),
    ]
