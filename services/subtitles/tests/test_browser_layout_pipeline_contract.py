from pathlib import Path
from typing import Any

from subtitles_service.domain.segments import normalize_segments_for_snapshot
from subtitles_service.domain.style import build_render_subtitles_payload
from subtitles_service.infrastructure.render import remotion


def test_browser_layout_lines_survive_normalize_and_render_payload():
    normalized = normalize_segments_for_snapshot(
        [
            {
                "id": "cue-1",
                "start_ms": 100,
                "end_ms": 900,
                "translated_text": "hola mundo",
                "layout": {
                    "lines": ["HOLA", "", "MUNDO", 123, "  FINAL  "],
                    "source": "browser-preview",
                    "unsafe": {"ignored": True},
                },
            }
        ]
    )

    assert normalized[0]["layout"] == {
        "lines": ["HOLA", "MUNDO", "FINAL"],
        "source": "browser-preview",
    }

    render_rows = build_render_subtitles_payload(normalized)

    assert render_rows[0]["layout"] == {
        "lines": ["HOLA", "MUNDO", "FINAL"],
        "source": "browser-preview",
    }


def test_invalid_layout_is_dropped_without_breaking_legacy_segments():
    normalized = normalize_segments_for_snapshot(
        [
            {
                "id": "cue-2",
                "start_ms": 100,
                "end_ms": 900,
                "translated_text": "hola mundo",
                "layout": {"lines": ["", 123, None]},
            }
        ]
    )

    assert "layout" not in normalized[0]
    assert "layout" not in build_render_subtitles_payload(normalized)[0]


def test_render_props_writer_includes_layout_without_source_video(monkeypatch, tmp_path):
    normalized = normalize_segments_for_snapshot(
        [
            {
                "id": "cue-1",
                "start_ms": 100,
                "end_ms": 900,
                "translated_text": "hola mundo",
                "layout": {"lines": ["HOLA", "MUNDO"], "source": "browser-preview"},
            }
        ]
    )

    monkeypatch.setattr(remotion, "run_render", lambda **_: None)

    remotion.render_black_subtitles_video(tmp_path, Path("source.mp4"), normalized)

    render_props = (tmp_path / "render-props.json").read_text(encoding="utf-8")
    assert '"layout"' in render_props
    assert '"lines"' in render_props
    assert '"browser-preview"' in render_props
    assert '"source_video_path"' not in render_props


# ---------------------------------------------------------------------------
# New tests for the `subtitles-fix-translation-foreign-to-spanish` change.
# These cover two contracts:
#   1. The snapshot preserves both `source_text` (original ASR) and
#      `translated_text` (Spanish) so the editor UI can show both.
#   2. When `source_language="auto"`, the pipeline uses Whisper's detected
#      language (normalized from BCP-47) to pick the right translator —
#      NOT the en-es fallback.
# ---------------------------------------------------------------------------


def test_normalize_preserves_source_text_and_translated_text():
    """A French upload should produce a snapshot where every segment
    carries both the original French (`source_text`) and the Spanish
    translation (`translated_text`). The legacy `text` field is no
    longer the only path.
    """
    normalized = normalize_segments_for_snapshot(
        [
            {
                "text": "BONJOUR",
                "translated_text": "HOLA",
                "source_text": "BONJOUR",
                "start_ms": 0,
                "end_ms": 1000,
            }
        ]
    )

    seg = normalized[0]
    assert seg["source_text"] == "BONJOUR"
    # `translate` is normalized to upper-case in the snapshot helper.
    assert seg["translated_text"] == "HOLA"


def test_auto_routes_to_detected_language_translator(monkeypatch):
    """When `source_language="auto"` and Whisper detects French
    (`info.language = "fr-FR"`), the pipeline MUST resolve the
    `fr -> es` Marian translator, NOT the `en -> es` fallback.
    """
    from subtitles_service.application.pipelines import analysis
    from subtitles_service.infrastructure.asr.whisper_asr import (
        WhisperTranscribeInfo,
    )
    from subtitles_service.infrastructure.translation import OpusMtTranslator

    # Build a fake ASR that returns French segments + a fr-FR info.
    class _FakeAsr:
        def transcribe(self, audio_path, language=None):
            return (
                [
                    {"text": "bonjour", "start_ms": 0, "end_ms": 1000},
                ],
                WhisperTranscribeInfo(language="fr-FR"),
            )

    # Build a fake Marian fr->es translator. Track that it was the one
    # actually called (and that the en-es translator was NOT).
    fr_called = {"value": False}
    en_called = {"value": False}

    class _FakeFrTranslator:
        def translate(self, segments, target="es"):
            fr_called["value"] = True
            return [
                {
                    "text": seg["text"],
                    "translated_text": f"<es:{seg['text']}>",
                    "source_text": seg["text"],
                    "start_ms": seg["start_ms"],
                    "end_ms": seg["end_ms"],
                }
                for seg in segments
            ]

    class _FakeEnTranslator:
        def translate(self, segments, target="es"):
            en_called["value"] = True
            return [
                {
                    "text": seg["text"],
                    "translated_text": f"<WRONG-EN-FALLBACK:{seg['text']}>",
                    "source_text": seg["text"],
                    "start_ms": seg["start_ms"],
                    "end_ms": seg["end_ms"],
                }
                for seg in segments
            ]

    def _fake_resolver(effective_source, target="es"):
        if effective_source == "fr":
            return _FakeFrTranslator()
        if effective_source == "en":
            return _FakeEnTranslator()
        raise AssertionError(
            f"unexpected effective_source={effective_source!r} (expected 'fr' or 'en')"
        )

    # Stub out the heavy parts of the pipeline: no ffmpeg, no real audio.
    # These helpers are imported lazily inside `run_real_analysis_pipeline`,
    # so we patch the source modules instead of the `analysis` module —
    # the analysis function does `from ... import WhisperTranscriber` and
    # `from ... import extract_audio_wav` inside the body, so patching
    # the source modules is the only way the fake will be picked up.
    from subtitles_service.infrastructure.media import audio as audio_mod
    from subtitles_service.infrastructure.asr import whisper_asr as whisper_mod

    monkeypatch.setattr(
        audio_mod,
        "extract_audio_wav",
        lambda src, dst: dst,
    )
    monkeypatch.setattr(
        audio_mod,
        "read_wav_duration_ms",
        lambda _p: 1000,
    )

    # `WhisperTranscriber.default()` is a `@classmethod`; patch the class
    # so its `default()` factory returns our fake.
    class _FakeDefaultFactory:
        @staticmethod
        def default():
            return _FakeAsr()

    monkeypatch.setattr(whisper_mod, "WhisperTranscriber", _FakeDefaultFactory)

    # `resolve_translator_for_source` is also imported lazily.
    from subtitles_service.infrastructure import translation as translation_mod

    monkeypatch.setattr(
        translation_mod, "resolve_translator_for_source", _fake_resolver
    )

    segments = analysis.run_real_analysis_pipeline(
        source_video_path=Path("/tmp/fake.mp4"),
        source_language="auto",
        target_language="es",
    )

    # The fr->es translator was used (NOT the en-es fallback).
    assert fr_called["value"] is True
    assert en_called["value"] is False
    # The output segment carries source_text (French) and translated_text (Spanish).
    assert len(segments) == 1
    assert segments[0]["source_text"] == "bonjour"
    assert segments[0]["translated_text"] == "<es:bonjour>"


def test_subtitles_whisper_client_delegates_to_shared_asr_worker(tmp_path):
    from subtitles_service.infrastructure.asr.whisper_asr import WhisperTranscriber

    class _FakeClient:
        def __init__(self):
            self.calls = []

        def transcribe(self, audio_path, language=None):
            self.calls.append((audio_path, language))
            return [{"text": "hola", "start_ms": 0, "end_ms": 500}], "es"

    client = _FakeClient()
    segments, info = WhisperTranscriber(client=client).transcribe(tmp_path / "audio.wav", language="auto")

    assert segments == [{"text": "hola", "start_ms": 0, "end_ms": 500}]
    assert info.language == "es"
    assert client.calls == [(tmp_path / "audio.wav", "auto")]


def test_subtitles_whisper_client_reports_worker_failures_as_pipeline_errors(tmp_path):
    import pytest

    from newsroom_worker_common.asr_client import AsrWorkerError
    from subtitles_service.domain.errors import ErrorCode, PipelineError
    from subtitles_service.infrastructure.asr.whisper_asr import WhisperTranscriber

    class _BrokenClient:
        def transcribe(self, audio_path, language=None):
            raise AsrWorkerError("gpu_busy", "GPU slot busy", 409)

    with pytest.raises(PipelineError) as failure:
        WhisperTranscriber(client=_BrokenClient()).transcribe(tmp_path / "audio.wav")

    assert failure.value.code == ErrorCode.ASR_FAILED
    assert "GPU slot busy" in failure.value.message


# ---------------------------------------------------------------------------
# Subtitles render audio contract (T27): the black subtitle render must keep
# the narration from the uploaded source instead of shipping a silent MP4.
# ---------------------------------------------------------------------------


def _run_ffmpeg(*args: str) -> None:
    import subprocess

    result = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def _probe_streams(path: Path) -> list[dict[str, Any]]:
    import json
    import subprocess

    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)["streams"]


def test_source_audio_is_muxed_into_the_black_subtitles_video(tmp_path):
    from subtitles_service.infrastructure.render.remotion import mux_source_audio

    source = tmp_path / "source.mp4"
    _run_ffmpeg(
        "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
    )
    rendered = tmp_path / "video-final.mp4"
    _run_ffmpeg("-f", "lavfi", "-i", "color=c=black:s=320x180:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(rendered))

    assert not any(stream["codec_type"] == "audio" for stream in _probe_streams(rendered))

    result = mux_source_audio(rendered, source)

    assert result == rendered
    streams = _probe_streams(rendered)
    assert any(stream["codec_type"] == "audio" for stream in streams)
    assert any(stream["codec_type"] == "video" and stream["codec_name"] == "h264" for stream in streams)


def test_mux_source_audio_is_a_no_op_without_a_source_audio_track(tmp_path):
    from subtitles_service.infrastructure.render.remotion import mux_source_audio

    rendered = tmp_path / "video-final.mp4"
    _run_ffmpeg("-f", "lavfi", "-i", "color=c=black:s=320x180:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(rendered))
    silent_source = tmp_path / "source.mp4"
    _run_ffmpeg("-f", "lavfi", "-i", "color=c=black:s=320x180:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(silent_source))

    assert mux_source_audio(rendered, silent_source) == rendered
    assert not any(stream["codec_type"] == "audio" for stream in _probe_streams(rendered))
