"""UI polish round 2 contracts.

These checks guard the systemic rules from the task detail so a later redesign
cannot silently regress them. Behavioural coverage (layout, i18n, axe, light
theme, screenshot hygiene) lives in ``e2e/visual-qa.spec.js``.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _css_files() -> list[Path]:
    return sorted((ROOT / "styles").rglob("*.css"))


def test_no_all_caps_transforms_remain_in_panel_styles():
    offenders = [
        str(path.relative_to(ROOT))
        for path in _css_files()
        if "text-transform: uppercase" in _read(path)
    ]
    assert offenders == []


def test_labels_and_buttons_use_the_ui_font_not_mono():
    base = _read(ROOT / "styles" / "base.css")
    control_label = base[base.index(".control-label"):]
    control_label = control_label[: control_label.index("}")]
    assert "font-family: var(--font-ui)" in control_label
    counter = base[base.index(".section-counter"):]
    counter = counter[: counter.index("}")]
    assert "font-family: var(--font-ui)" in counter

    radar = _read(ROOT / "styles" / "features" / "radar.css")
    for selector in (
        "#viewRadar .radar-kicker",
        "#viewRadar .radar-status-chip",
        "#viewRadar .radar-monitor-card__actions button",
        "#viewRadar .radar-monitor-card__mentions-title",
    ):
        block = radar[radar.index(selector):]
        block = block[: block.index("}")]
        assert "var(--font-ui)" in block, selector
        assert "JetBrains Mono" not in block, selector


def test_remaining_copy_exists_in_both_languages():
    es = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "es.json"))
    en = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "en.json"))
    assert set(es) == set(en)
    for key, source, translated in (
        ("radar.trash", "Descartadas", "Discarded"),
        ("radar.mentions", "Menciones:", "Mentions:"),
        ("subtitles.title", "Subtítulos", "Subtitles"),
        ("radar.destination", "Destino: {value}", "Destination: {value}"),
    ):
        assert es[key] == source, key
        assert en[key] == translated, key


def test_admin_users_expose_an_actions_header_and_readable_input_borders():
    render = _read(ROOT / "js" / "modules" / "features" / "admin-users" / "render.js")
    assert "t('users.actions')" in render
    css = _read(ROOT / "styles" / "features" / "admin-users.css")
    assert "var(--border-input)" in css
    tokens = _read(ROOT / "styles" / "tokens.css")
    assert tokens.count("--border-input:") == 2


def test_ui_colour_literals_live_only_in_render_or_brand_assets():
    """UI chrome must read tokens; composition/cue/brand art may hard-code."""
    allowed = (
        "js/modules/features/video-projects/composition/",
        "js/modules/features/subtitles/controller/render-workflow.js",
        "js/modules/features/subtitles/runtime/presentation.js",
        "js/modules/features/subtitles/runtime/services.js",
        "js/modules/subtitles-workflow.mjs",
        "favicon.svg",
        "js/modules/features/video-projects/data/row-video-commands.js",
        "/__checks__/",
    )
    offenders = []
    for path in sorted((ROOT / "js").rglob("*")) + [ROOT / "index.html", ROOT / "favicon.svg"]:
        if not path.is_file() or path.suffix not in {"", ".js", ".mjs", ".html", ".svg"}:
            continue
        relative = str(path.relative_to(ROOT))
        if any(relative.startswith(prefix) or prefix in relative for prefix in allowed):
            continue
        if re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(", _read(path)):
            offenders.append(relative)
    assert offenders == []


def test_generated_brand_art_has_no_license_tagline_and_is_documented():
    generator = _read(REPO / "tools" / "assets" / "generate_demo_assets.py")
    assert "LOCAL DEMO / CC0" not in generator
    assert "LOCAL DEMO" not in generator
    assets = _read(REPO / "ASSETS.md")
    assert "LOCAL DEMO / " not in assets
    assert "logo-demo.webm" in assets
    assert "generate_demo_assets.py" in assets
    assert subprocess.run(
        ["python3", "-m", "py_compile", str(REPO / "tools" / "assets" / "generate_demo_assets.py")],
        capture_output=True,
    ).returncode == 0
