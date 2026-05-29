from __future__ import annotations

import json

from app.ai_rescue import (
    AiRescueAnalyzer,
    AiRescueVideoInput,
    build_ai_rescue_prompt,
    parse_ai_rescue_response,
)
from app.title_matcher import TitleCatalog
from app.youtube_client import SubtitleSegment


def test_prompt_builder_uses_configured_non_source_targets_and_subtitle_evidence_only():
    video = AiRescueVideoInput(
        video_id="trash-1",
        title="Colombia postgame show",
        source_country="colombia",
        source_language="es",
        segments=[
            SubtitleSegment(start_ms=1000, end_ms=12000, text="Ecuador fue brillante", language="es"),
            SubtitleSegment(start_ms=13000, end_ms=24000, text="Argentina jugó fútbol hermoso", language="es"),
        ],
    )
    prompt = build_ai_rescue_prompt(
        video=video,
        catalog=TitleCatalog(countries={"colombia": [], "ecuador": [], "argentina": [], "peru": []}),
    )

    assert '"allowed_target_countries":["ecuador","argentina","peru"]' in prompt
    assert "colombia" in prompt
    assert "Do not use audio" in prompt
    assert "Ecuador fue brillante" in prompt
    assert "Argentina jugó fútbol hermoso" in prompt


def test_prompt_builder_includes_long_subtitle_inputs_far_beyond_legacy_segment_limit():
    segments = [
        SubtitleSegment(start_ms=index * 1000, end_ms=index * 1000 + 900, text=f"segment {index} fútbol excelente", language="es")
        for index in range(900)
    ]
    prompt = build_ai_rescue_prompt(
        video=AiRescueVideoInput(
            video_id="long-video",
            title="Long show",
            source_country="argentina",
            source_language="es",
            segments=segments,
        ),
        catalog=TitleCatalog(countries={"argentina": [], "ecuador": []}),
    )
    payload = json.loads(prompt)

    assert len(payload["video"]["subtitles"]) == 900
    assert payload["video"]["subtitle_window"]["included_segments"] == 900
    assert payload["video"]["subtitle_window"]["total_segments"] == 900
    assert payload["video"]["subtitle_window"]["truncated"] is False
    assert payload["video"]["subtitle_window"]["included_characters"] > 20_000
    assert payload["video"]["subtitles"][-1]["text"] == "segment 899 fútbol excelente"


def test_prompt_builder_truncates_only_at_configured_high_character_ceiling():
    segments = [
        SubtitleSegment(
            start_ms=index * 1000,
            end_ms=index * 1000 + 900,
            text=f"segment {index} " + ("fútbol excelente " * 20),
            language="es",
        )
        for index in range(900)
    ]
    prompt = build_ai_rescue_prompt(
        video=AiRescueVideoInput(
            video_id="long-video",
            title="Long show",
            source_country="argentina",
            source_language="es",
            segments=segments,
        ),
        catalog=TitleCatalog(countries={"argentina": [], "ecuador": []}),
        subtitle_max_characters=75_000,
        subtitle_hard_max_characters=80_000,
    )
    payload = json.loads(prompt)

    assert 200 < len(payload["video"]["subtitles"]) < 900
    assert payload["video"]["subtitle_window"]["included_segments"] == len(payload["video"]["subtitles"])
    assert payload["video"]["subtitle_window"]["total_segments"] == 900
    assert payload["video"]["subtitle_window"]["included_characters"] <= 75_000
    assert payload["video"]["subtitle_window"]["total_characters"] > 75_000
    assert payload["video"]["subtitle_window"]["max_characters"] == 75_000
    assert payload["video"]["subtitle_window"]["truncated"] is True


def test_prompt_builder_clamps_configured_limit_to_hard_safety_ceiling():
    segments = [
        SubtitleSegment(
            start_ms=index * 1000,
            end_ms=index * 1000 + 900,
            text=f"segment {index} " + ("fútbol excelente " * 20),
            language="es",
        )
        for index in range(900)
    ]
    prompt = build_ai_rescue_prompt(
        video=AiRescueVideoInput(
            video_id="long-video",
            title="Long show",
            source_country="argentina",
            source_language="es",
            segments=segments,
        ),
        catalog=TitleCatalog(countries={"argentina": [], "ecuador": []}),
        subtitle_max_characters=1_000_000,
        subtitle_hard_max_characters=20_000,
    )
    payload = json.loads(prompt)

    assert payload["video"]["subtitle_window"]["configured_max_characters"] == 1_000_000
    assert payload["video"]["subtitle_window"]["hard_max_characters"] == 20_000
    assert payload["video"]["subtitle_window"]["max_characters"] == 20_000
    assert payload["video"]["subtitle_window"]["included_characters"] <= 20_000
    assert payload["video"]["subtitle_window"]["truncated"] is True


def test_parser_accepts_strict_json_candidates_with_positive_football_evidence_and_rejections():
    payload = json.dumps(
        {
            "candidates": [
                {
                    "target_country": "ecuador",
                    "score": 86,
                    "summary_es": "Elogian a Ecuador por su fútbol.",
                    "angle_es": "Buen ángulo editorial de rendimiento futbolístico.",
                    "risk": "low",
                    "risks": ["Sin riesgo relevante"],
                    "evidence": [
                        {
                            "start_ms": 1000,
                            "end_ms": 12000,
                            "text": "Ecuador played excellent football",
                            "translation_es": "Ecuador jugó excelente fútbol",
                            "explanation_es": "Elogio futbolístico positivo explícito.",
                        },
                        {
                            "start_ms": 13000,
                            "end_ms": 23000,
                            "text": "They deserve praise for the match",
                            "translation_es": "Merecen elogios por el partido",
                            "explanation_es": "Refuerza evidencia positiva de fútbol.",
                        },
                    ],
                }
            ],
            "rejections": [
                {"target_country": "mexico", "reason": "weak-evidence", "explanation_es": "Mención casual."}
            ],
        }
    )

    result = parse_ai_rescue_response(payload, source_country="colombia", allowed_target_countries=["ecuador", "mexico"])

    assert [(candidate.target_country, candidate.score, candidate.risk) for candidate in result.candidates] == [
        ("ecuador", 86, "low")
    ]
    assert result.candidates[0].evidence_duration_ms == 21000
    assert [(rejection.target_country, rejection.reason) for rejection in result.rejections] == [("mexico", "weak-evidence")]


def test_parser_rejects_malformed_unconfigured_same_source_metadata_only_and_weak_evidence():
    payload = json.dumps(
        {
            "candidates": [
                {
                    "target_country": "colombia",
                    "score": 91,
                    "summary_es": "Fuente local.",
                    "angle_es": "No debería aprobarse.",
                    "risk": "low",
                    "risks": ["same source"],
                    "evidence": [
                        {
                            "start_ms": 1000,
                            "end_ms": 25000,
                            "text": "Colombia played well",
                            "translation_es": "Colombia jugó bien",
                            "explanation_es": "Elogio futbolístico.",
                        }
                    ],
                },
                {
                    "target_country": "peru",
                    "score": 72,
                    "summary_es": "No configurado.",
                    "angle_es": "No debería aprobarse.",
                    "risk": "medium",
                    "risks": ["unconfigured"],
                    "evidence": [
                        {
                            "start_ms": 1000,
                            "end_ms": 25000,
                            "text": "Peru played football well",
                            "translation_es": "Perú jugó bien al fútbol",
                            "explanation_es": "Elogio futbolístico.",
                        }
                    ],
                },
                {
                    "target_country": "ecuador",
                    "score": 81,
                    "summary_es": "Elogio insuficiente.",
                    "angle_es": "Falta duración.",
                    "risk": "low",
                    "risks": ["short evidence"],
                    "evidence": [
                        {
                            "start_ms": 1000,
                            "end_ms": 5000,
                            "text": "Ecuador nice football",
                            "translation_es": "Ecuador bien fútbol",
                            "explanation_es": "Elogio futbolístico muy corto.",
                        }
                    ],
                },
            ],
            "rejections": [],
        }
    )

    result = parse_ai_rescue_response(payload, source_country="colombia", allowed_target_countries=["ecuador"])

    assert result.candidates == []
    assert [(rejection.target_country, rejection.reason) for rejection in result.rejections] == [
        ("colombia", "source-country"),
        ("peru", "unconfigured-target"),
        ("ecuador", "insufficient-evidence"),
    ]


def test_analyzer_calls_client_once_and_returns_score_sorted_candidates():
    class FakeClient:
        def __init__(self):
            self.prompts: list[str] = []

        def complete_json(self, prompt: str) -> str:
            self.prompts.append(prompt)
            return json.dumps(
                {
                    "candidates": [
                        _candidate("mexico", 64),
                        _candidate("ecuador", 91),
                    ],
                    "rejections": [],
                }
            )

    client = FakeClient()
    analyzer = AiRescueAnalyzer(client=client, catalog=TitleCatalog(countries={"colombia": [], "ecuador": [], "mexico": []}))
    video = AiRescueVideoInput(
        video_id="trash-1",
        title="Colombia show",
        source_country="colombia",
        source_language="es",
        segments=[SubtitleSegment(start_ms=0, end_ms=22000, text="Ecuador y México jugaron gran fútbol", language="es")],
    )

    result = analyzer.analyze(video)

    assert [candidate.target_country for candidate in result.candidates] == ["ecuador", "mexico"]
    assert len(client.prompts) == 1


def _candidate(target_country: str, score: int) -> dict:
    return {
        "target_country": target_country,
        "score": score,
        "summary_es": f"Elogio a {target_country} por fútbol.",
        "angle_es": "Rendimiento futbolístico destacado.",
        "risk": "low",
        "risks": ["Sin riesgo"],
        "evidence": [
            {
                "start_ms": 1000,
                "end_ms": 23000,
                "text": f"{target_country} played great football",
                "translation_es": f"{target_country} jugó gran fútbol",
                "explanation_es": "Elogio futbolístico positivo explícito.",
            }
        ],
    }
