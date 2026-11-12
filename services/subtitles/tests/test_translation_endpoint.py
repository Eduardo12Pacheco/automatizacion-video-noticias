from __future__ import annotations

from typing import Any

import pytest


def test_translate_endpoint_uses_the_shared_translation_resolver(
    client,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    class FakeTranslator:
        def translate(self, segments, target="es"):
            calls.append({"segments": segments, "target": target})
            return [
                {
                    **segment,
                    "source_text": segment["text"],
                    "translated_text": f"[{target}] {segment['text']}",
                }
                for segment in segments
            ]

    def fake_resolver(source: str, target: str = "es"):
        calls.append({"source": source, "target": target})
        return FakeTranslator()

    monkeypatch.setattr(
        "subtitles_service.api.routes.subtitles.resolve_translator_for_source",
        fake_resolver,
    )

    response = client.post(
        "/api/subtitles/translate",
        headers=auth_headers,
        json={
            "segments": [
                {"text": "hello world", "start_ms": 0, "end_ms": 900},
                {"text": "second line", "start_ms": 900, "end_ms": 1800},
            ],
            "source_language": "en",
            "target_language": "es",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source_language"] == "en"
    assert body["target_language"] == "es"
    assert [segment["translated_text"] for segment in body["segments"]] == ["[es] hello world", "[es] second line"]
    assert calls[0] == {"source": "en", "target": "es"}
    assert calls[1]["segments"] == [
        {"text": "hello world", "start_ms": 0, "end_ms": 900},
        {"text": "second line", "start_ms": 900, "end_ms": 1800},
    ]


def test_translate_endpoint_resolves_auto_with_the_detected_language(
    client,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sources: list[str] = []

    class FakeTranslator:
        def translate(self, segments, target="es"):
            return [{**segment, "translated_text": segment["text"]} for segment in segments]

    def fake_resolver(source: str, target: str = "es"):
        sources.append(source)
        return FakeTranslator()

    monkeypatch.setattr(
        "subtitles_service.api.routes.subtitles.resolve_translator_for_source",
        fake_resolver,
    )

    response = client.post(
        "/api/subtitles/translate",
        headers=auth_headers,
        json={
            "segments": [{"text": "bonjour", "start_ms": 0, "end_ms": 500}],
            "source_language": "auto",
            "detected_language": "fr",
            "target_language": "es",
        },
    )

    assert response.status_code == 200, response.text
    assert sources == ["fr"]


def test_translate_endpoint_rejects_invalid_payloads(client, auth_headers: dict[str, str]) -> None:
    missing_segments = client.post(
        "/api/subtitles/translate",
        headers=auth_headers,
        json={"segments": [], "source_language": "en", "target_language": "es"},
    )
    assert missing_segments.status_code == 400
    assert missing_segments.json()["detail"]["code"] == "video_input_contract_violation"

    auto_without_detection = client.post(
        "/api/subtitles/translate",
        headers=auth_headers,
        json={"segments": [{"text": "hello", "start_ms": 0, "end_ms": 1}], "source_language": "auto", "target_language": "es"},
    )
    assert auto_without_detection.status_code == 400
    assert auto_without_detection.json()["detail"]["code"] == "unsupported_source_language"

    unauthenticated = client.post(
        "/api/subtitles/translate",
        json={"segments": [{"text": "hello", "start_ms": 0, "end_ms": 1}], "source_language": "en"},
    )
    assert unauthenticated.status_code == 401
