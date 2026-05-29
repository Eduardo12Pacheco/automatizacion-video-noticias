from __future__ import annotations

import json
from pathlib import Path

from app.catalog import expand_catalog, get_catalog_summary
from app.mention_engine import find_mentions, normalize_text
from app.models import TargetProfile, TranscriptSegment


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def test_mention_engine_matches_profile_aliases_case_and_diacritics_with_segment_timestamps():
    segments = [
        TranscriptSegment(id="s1", start_ms=5000, end_ms=9000, text="La seleccion Colombia presiona."),
        TranscriptSegment(id="s2", start_ms=12000, end_ms=15000, text="Café sin fútbol."),
    ]
    target = TargetProfile(type="country", name="Colombia", aliases=["Selección Colombia"])

    matches = find_mentions(segments, target=target, extra_keywords=["cafe"])

    assert [(m.keyword, m.canonical, m.segment_id, m.start_ms, m.end_ms) for m in matches] == [
        ("seleccion colombia", "Colombia", "s1", 5000, 9000),
        ("cafe", "cafe", "s2", 12000, 15000),
    ]
    assert normalize_text("Selección CAFÉ") == "seleccion cafe"


def test_mention_engine_prefers_longer_overlapping_terms_and_preserves_no_match_empty_list():
    segments = [TranscriptSegment(id="s1", start_ms=7000, end_ms=10000, text="Luis Diaz y Diaz aparecen.")]
    target = TargetProfile(type="player", name="Luis Díaz", aliases=["Diaz"])

    matches = find_mentions(segments, target=target, extra_keywords=[])

    assert [(m.keyword, m.segment_id, m.text) for m in matches] == [
        ("luis diaz", "s1", "Luis Diaz y Diaz aparecen."),
        ("diaz", "s1", "Luis Diaz y Diaz aparecen."),
    ]

    no_matches = find_mentions(
        [TranscriptSegment(id="s2", start_ms=11000, end_ms=13000, text="Sin nombres propios.")],
        target=target,
        extra_keywords=["argentina"],
    )
    assert no_matches == []


def test_catalog_expands_selected_country_variants_for_supported_languages():
    catalog = get_catalog_summary()

    assert [country["code"] for country in catalog["countries"]] == [
        "ecuador",
        "colombia",
        "argentina",
        "uruguay",
        "paraguay",
        "mexico",
    ]

    expanded = expand_catalog(["colombia", "ecuador", "argentina"], "fr")
    variants = {entry.canonical: entry.variants for entry in expanded}

    assert "James Rodríguez" in variants
    assert "James Rodrigue" in variants["James Rodríguez"]
    assert "Moisés Caicedo" in variants
    assert "Moise Caicedo" in variants["Moisés Caicedo"]
    assert "Lionel Messi" in variants
    assert "Lionel Messie" in variants["Lionel Messi"]


def test_catalog_expands_nl_and_asr_aliases_into_spanish_canonical_entities():
    expanded = expand_catalog(["uruguay", "paraguay", "mexico"], "nl")
    variants = {entry.canonical: entry.variants for entry in expanded}

    assert "Uruguay" in variants
    assert "Oeroegwaj" in variants["Uruguay"]
    assert "Miguel Almirón" in variants
    assert "Miguel Almiron" in variants["Miguel Almirón"]
    assert "México" in variants
    assert "Mejico" in variants["México"]


def test_catalog_unknown_language_falls_back_to_base_names_and_surnames_only():
    expanded = expand_catalog(["colombia"], "ja")

    james = next(entry for entry in expanded if entry.canonical == "James Rodríguez")

    assert james.variants == ["James Rodríguez", "Rodríguez"]


def test_mention_engine_matches_country_catalog_variants_with_selected_country_metadata():
    segments = [TranscriptSegment(id="s1", start_ms=12000, end_ms=18000, text="James Rodrigue maneja a Colombia.")]

    matches = find_mentions(segments, countries=["colombia"], detected_language="fr", extra_keywords=["bloque alto"])

    assert [(m.keyword, m.canonical, m.country, m.segment_id, m.start_ms) for m in matches] == [
        ("james rodrigue", "James Rodríguez", "colombia", "s1", 12000),
        ("colombia", "Colombia", "colombia", "s1", 12000),
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
        TranscriptSegment(id="s1", start_ms=5000, end_ms=9000, text="Pachio domina para Equateur."),
        TranscriptSegment(id="s2", start_ms=11000, end_ms=14000, text="Mejico espera a Santi Gimenez."),
    ]

    matches = find_mentions(segments, countries=["ecuador", "mexico"], detected_language="fr", extra_keywords=[])

    assert [(m.keyword, m.canonical, m.country, m.start_ms) for m in matches] == [
        ("pachio", "Willian Pacho", "ecuador", 5000),
        ("equateur", "Ecuador", "ecuador", 5000),
        ("mejico", "México", "mexico", 11000),
        ("santi gimenez", "Santiago Giménez", "mexico", 11000),
    ]
