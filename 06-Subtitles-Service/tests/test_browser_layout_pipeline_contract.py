from pathlib import Path

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


def test_render_props_writer_includes_layout_and_source_video(monkeypatch, tmp_path):
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
    assert '"source_video_path"' in render_props
    assert '"source.mp4"' in render_props
