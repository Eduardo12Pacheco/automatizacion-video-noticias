"""UI refresh contract.

These checks replace the older grep-only web.pen snapshots: they guard the
Acceptance items (typography, buttons, tokens, dialogs, i18n, navigation,
accessibility, responsive breakpoints and showcase mode) without freezing a
single visual composition.
"""
from pathlib import Path
import json
import re
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
STYLES = ROOT / "styles"
INDEX = ROOT / "index.html"
TOKENS = STYLES / "tokens.css"
BUTTONS = STYLES / "components" / "buttons.css"
DIALOGS = STYLES / "components" / "dialogs.css"
RESPONSIVE = STYLES / "responsive.css"
TEMPLATES = ROOT / "js" / "modules" / "app-shell" / "views" / "templates"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _run_node(script: str):
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def test_two_family_typography_with_scale_tokens():
    fonts = _read(STYLES / "fonts.css")
    base = _read(STYLES / "base.css")
    tokens = _read(TOKENS)

    assert "font-family: 'Inter'" in fonts
    assert "font-family: 'JetBrains Mono'" in fonts
    assert "Space Grotesk" not in fonts
    assert "font-display: optional" not in fonts
    assert fonts.count("font-display: swap") >= 2
    assert "fonts.gstatic.com" not in fonts
    assert "assets/fonts/inter/" in fonts
    assert "assets/fonts/jetbrains-mono/" in fonts
    assert "font-family: var(--font-ui);" in base
    for token in ["--fs-12", "--fs-14", "--fs-16", "--fs-20", "--fs-24", "--fs-32"]:
        assert f"{token}:" in tokens
    buttons = _read(BUTTONS)
    assert "font-family: var(--font-ui);" in buttons
    assert "font-size: var(--fs-14);" in buttons
    assert "font-weight: 600;" in buttons
    assert "text-transform: none;" in buttons


def test_one_token_source_and_few_raw_colors_outside_it():
    token_text = _read(TOKENS)
    for token in [
        "--bg:", "--bg-elevated:", "--surface:", "--surface-soft:",
        "--surface-muted:", "--surface-strong:", "--border:", "--border-strong:",
        "--text:", "--muted:", "--muted-2:", "--accent:", "--success:", "--warning:",
        "--danger:", "--info:", "--space-1:", "--radius-sm:",
    ]:
        assert token in token_text
    # --subtitle2-* now live in the single token source.
    assert "--subtitle2-base:" in token_text
    assert "--subtitle2-base:" not in _read(STYLES / "features" / "subtitles" / "tokens.css")

    raw_pattern = re.compile(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)")
    raw_count = 0
    for path in STYLES.rglob("*.css"):
        if path == TOKENS:
            continue
        raw_count += len(raw_pattern.findall(_read(path)))
    assert raw_count < 40, f"raw colors outside tokens.css: {raw_count}"


def test_i18n_catalogs_and_language_switch():
    es = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "es.json"))
    en = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "en.json"))
    assert set(es) == set(en)
    assert es["nav.press"] == "Prensa"
    assert en["nav.press"] == "Press"

    index = _read(INDEX)
    assert '<html lang="es">' in index
    assert 'id="languageSelect"' in index
    assert 'data-i18n="settings.language"' in index
    assert index.count("data-i18n") > 30
    for template in TEMPLATES.glob("*.js"):
        assert "data-i18n" in _read(template), f"{template.name} lacks data-i18n"

    script = r"""
import { createI18n } from './js/modules/core/i18n/index.js';
const memory = new Map();
const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
const documentRef = { querySelectorAll: () => [], documentElement: {}, dispatchEvent() {} };
const i18n = createI18n({ storage, documentRef });
if (i18n.t('nav.press') !== 'Prensa') throw new Error('ES default drift');
i18n.setLanguage('en');
if (i18n.t('nav.press') !== 'Press') throw new Error('EN translation drift');
if (memory.get('newsroom-panel-language-v1') !== 'en') throw new Error('language not persisted');
if (documentRef.documentElement.lang !== 'en') throw new Error('html lang not updated');
if (i18n.t('common.words', { count: 3 }) !== 'Words: 3') throw new Error('interpolation drift');
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


