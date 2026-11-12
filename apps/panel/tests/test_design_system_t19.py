"""T19 design-system contract (S5/S10).

The checks here are deliberately mechanical: a generated-name or a raw colour
sneaking back into a feature stylesheet, a font-size outside the scale or a
fourth breakpoint fails the suite instead of silently rotting the design.
"""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]
STYLES = ROOT / "styles"
TOKENS = STYLES / "tokens.css"
FONTS = STYLES / "fonts.css"
INDEX = ROOT / "index.html"
RESPONSIVE = STYLES / "responsive.css"
THEME = ROOT / "js" / "modules" / "core" / "theme" / "index.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _feature_css() -> list[Path]:
    return [path for path in STYLES.rglob("*.css") if path != TOKENS]


def test_no_generated_palette_names_outside_the_token_file():
    offenders = []
    for path in _feature_css():
        text = _read(path)
        if re.search(r"--c-rgb-", text):
            offenders.append(f"{path}: generated rgb name")
        if re.search(r"--c-[0-9a-f]{3,8}\b", text):
            offenders.append(f"{path}: generated hex name")
    assert offenders == []


def test_no_raw_colour_literals_outside_the_token_file():
    pattern = re.compile(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)")
    offenders = []
    for path in _feature_css():
        matches = pattern.findall(_read(path))
        if matches:
            offenders.append(f"{path}: {len(matches)} raw colour(s)")
    assert offenders == []


def test_one_radius_scale_without_duplicates():
    tokens = _read(TOKENS)
    radii = re.findall(r"(--radius-[a-z]+):\s*([^;]+);", tokens)
    names = [name for name, _ in radii]
    assert len(names) == len(set(names)), f"duplicate radius tokens: {names}"
    assert {"--radius-sm", "--radius-md", "--radius-lg"}.issubset(names)
    # Only circles (50%) may bypass the scale in feature styles.
    literals = []
    for path in _feature_css():
        for match in re.finditer(r"border-radius:\s*([^;]+);", _read(path)):
            value = match.group(1).strip()
            if value.startswith("var(") or value in {"50%", "inherit"}:
                continue
            literals.append(f"{path}: {value}")
    assert literals == []


def test_selected_card_no_longer_uses_the_amber_gradient():
    approval = _read(STYLES / "features" / "approval.css")
    selected = approval.split(".script-selection-card.is-selected", 1)[1].split("}", 1)[0]
    assert "warning" not in selected
    assert "accent" in selected


def test_fonts_are_self_hosted_with_licences():
    fonts = _read(FONTS)
    assert "fonts.gstatic.com" not in fonts
    assert "fonts.googleapis.com" not in fonts
    assert "Playfair" not in _read(STYLES / "features" / "auth.css")
    for family, folder in (("Inter", "inter"), ("JetBrains Mono", "jetbrains-mono")):
        assert f"font-family: '{family}'" in fonts
        files = list((ROOT / "assets" / "fonts" / folder).glob("*.woff2"))
        assert files, f"missing self-hosted {family} woff2"
        licence = ROOT / "assets" / "fonts" / folder / "OFL.txt"
        assert licence.exists(), f"missing OFL for {family}"
        assert "SIL Open Font License" in _read(licence)
    index = _read(INDEX)
    assert "gstatic.com" not in index


def test_font_sizes_use_the_type_scale():
    declarations = 0
    tokenised = 0
    for path in _feature_css():
        for match in re.finditer(r"font-size:\s*([^;]+);", _read(path)):
            declarations += 1
            if match.group(1).strip().startswith("var(--fs-"):
                tokenised += 1
    assert declarations > 0
    assert tokenised / declarations >= 0.95, f"{tokenised}/{declarations} font sizes tokenised"


def test_three_layout_ranges_and_mobile_menu():
    widths = set()
    for path in STYLES.rglob("*.css"):
        widths.update(re.findall(r"@media \(max-width: (\d+)px\)", _read(path)))
    assert widths == {"1199", "859"}, widths

    responsive = _read(RESPONSIVE)
    narrow = responsive.split("@media (max-width: 859px)", 1)[1]
    assert "position: sticky;" in narrow
    assert "mobile-nav-toggle" in narrow
    assert "is-nav-open .sidebar-nav" in narrow
    index = _read(INDEX)
    assert 'id="mobileNavToggle"' in index
    assert 'aria-controls="sidebarNav"' in index
    # The rail must not expand just because a child keeps focus.
    for path in _feature_css():
        assert "sidebar--rail:focus-within" not in _read(path), f"{path} still expands the rail on focus-within"


def test_light_theme_is_persisted_and_respects_the_system_preference():
    script = r"""
import { resolveInitialTheme, createThemeController, THEME_STORAGE_KEY } from './js/modules/core/theme/index.js';

const storedLight = { getItem: () => 'light', setItem() {} };
if (resolveInitialTheme({ storage: storedLight, matchMedia: () => ({ matches: false }) }) !== 'light') {
  throw new Error('stored theme must win');
}
const systemLight = { getItem: () => null, setItem() {} };
if (resolveInitialTheme({ storage: systemLight, matchMedia: (q) => ({ matches: q.includes('light') }) }) !== 'light') {
  throw new Error('prefers-color-scheme not honoured on first visit');
}
if (resolveInitialTheme({ storage: systemLight, matchMedia: () => ({ matches: false }) }) !== 'dark') {
  throw new Error('dark must stay the default');
}
const memory = new Map();
const attrs = {};
const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
const controller = createThemeController({
  storage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) },
  documentRef: doc,
  matchMedia: () => ({ matches: false }),
});
controller.setTheme('light');
if (attrs['data-theme'] !== 'light') throw new Error('data-theme not applied');
if (memory.get(THEME_STORAGE_KEY) !== 'light') throw new Error('theme not persisted');
"""
    import subprocess
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

    index = _read(INDEX)
    assert "prefers-color-scheme: light" in index
    assert 'id="themeSelect"' in index
    runtime = _read(ROOT / "js" / "modules" / "app-shell" / "runtime.js")
    assert "createThemeController" in runtime
    assert "theme.setTheme" in runtime


def test_theme_catalogs_stay_in_sync():
    es = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "es.json"))
    en = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "en.json"))
    assert set(es) == set(en)
    for key in ("settings.theme", "settings.themeDark", "settings.themeLight", "nav.openMenu"):
        assert key in es and key in en
