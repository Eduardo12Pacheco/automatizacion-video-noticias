"""Design-system contract.

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
    theme_bootstrap = _read(ROOT / "js" / "theme-init.js")
    assert "prefers-color-scheme: light" in theme_bootstrap
    assert '<script src="./js/theme-init.js"></script>' in index
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


def test_index_has_no_spanish_copy_outside_the_catalogs():
    from html.parser import HTMLParser

    allowed = {"Español", "English", "×", "AP", "Demo Sports News", "Unified", "!", "＋", "↻", "⇄", "◎", "i"}

    class Scanner(HTMLParser):
        def __init__(self):
            super().__init__()
            self.stack = []
            self.problems = []

        def handle_starttag(self, tag, attrs):
            self.stack.append((tag, dict(attrs)))

        def handle_endtag(self, tag):
            if self.stack:
                self.stack.pop()

        def handle_data(self, data):
            text = data.strip()
            if not text or text in allowed:
                return
            if not re.search(r"[áéíóúñÁÉÍÓÚÑ¿¡]", text):
                return
            translated = any("data-i18n" in attrs for _, attrs in self.stack)
            if not translated:
                self.problems.append(text)

    scanner = Scanner()
    scanner.feed(_read(INDEX))
    assert scanner.problems == []

    # Attributes with user-facing Spanish copy must be bound to the catalog too.
    for match in re.finditer(r'(placeholder|title|aria-label)="([^"]*)"', _read(INDEX)):
        attribute, value = match.groups()
        if not re.search(r"[áéíóúñÁÉÍÓÚÑ¿¡]", value):
            continue
        source = _read(INDEX)
        start = source.rfind("<", 0, match.start())
        end = source.find(">", match.end())
        tag = source[start:end]
        assert f"data-i18n-{attribute}" in tag, f"{attribute}={value!r} is not translated"


def test_catalogs_cover_both_languages_with_matching_keys():
    es = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "es.json"))
    en = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "en.json"))
    assert set(es) == set(en)
    assert all(str(value).strip() for value in es.values())
    assert all(str(value).strip() for value in en.values())
    for key in (
        "radar.destination",
        "radar.channelLabel",
        "radar.uploaded",
        "radar.status.geoBlocked",
        "subtitles.serverOnline",
        "subtitles.previewEyebrow",
        "nav.activeUsers",
    ):
        assert key in es, key
        assert key in en, key


def test_named_t19_strings_are_translated():
    es = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "es.json"))
    en = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "en.json"))
    corpus = " ".join(list(es.values()) + list(en.values()))
    for literal in [
        "Roles",
        "Errors",
        "Nuevo",
        "Servidor desconectado",
        "Todavía no hay sesiones remotas.",
        "Detecta automáticamente",
        "Cola de jobs",
        "Usuarios activos",
    ]:
        assert literal.lower() in corpus.lower(), f"missing translation coverage for {literal!r}"
    for internal in ("API Gateway", "Basic Auth", "M2M100", "Marian"):
        assert internal.lower() not in corpus.lower(), f"internal jargon leaked into the catalog: {internal!r}"


def test_feature_renderers_translate_at_render_time_instead_of_rewriting_the_dom():
    assert not (ROOT / "js" / "modules" / "core" / "i18n" / "phrases.js").exists()
    i18n = _read(ROOT / "js" / "modules" / "core" / "i18n" / "index.js")
    runtime = _read(ROOT / "js" / "modules" / "app-shell" / "runtime.js")
    assert "installDomLocalizer" not in i18n
    assert "installDomLocalizer" not in runtime
    assert "MutationObserver" not in i18n
    assert "translateText" not in i18n
    renderers = [
        ROOT / "js" / "modules" / "features" / "radar" / "render.js",
        ROOT / "js" / "modules" / "features" / "active-users" / "render.js",
        ROOT / "js" / "modules" / "features" / "admin-users" / "render.js",
        ROOT / "js" / "modules" / "features" / "errors-audit" / "render.js",
        ROOT / "js" / "modules" / "features" / "scripts" / "render.js",
    ]
    for path in renderers:
        source = _read(path)
        assert "from '../../core/i18n/index.js'" in source, path
        assert "t(" in source, path
    radar = _read(ROOT / "js" / "modules" / "features" / "radar" / "render.js")
    assert "Destino:" not in radar
    assert "Canal:" not in radar
    assert "Subido " not in radar


def test_focus_rings_are_never_removed_without_a_visible_replacement():
    offenders = []
    for path in _feature_css():
        for match in re.finditer(r"outline:\s*none", _read(path)):
            line_start = _read(path).rfind("\n", 0, match.start())
            rule_start = _read(path).rfind("{", 0, match.start())
            selector = _read(path)[line_start + 1:rule_start]
            if ":focus" in selector or ":focus-visible" in selector:
                offenders.append(f"{path}: {selector.strip()}")
    assert offenders == []
    base = _read(STYLES / "base.css")
    assert ":focus-visible" in base
    assert "outline: 2px solid var(--accent);" in base


def test_admin_create_user_inputs_are_visible_and_labelled():
    template = _read(ROOT / "js" / "modules" / "app-shell" / "views" / "templates" / "admin-users-view.js")
    for field in ("adminUserName", "adminUserEmail", "adminUserPassword"):
        assert f'id="{field}"' in template
        assert f'<label class="settings-field">' in template
    admin = _read(STYLES / "features" / "admin-users.css")
    assert ".admin-users-form input," in admin
    assert "border: 1px solid var(--border-input);" in admin
    assert "background: var(--surface-1);" in admin


def test_axe_runs_against_every_view():
    root = ROOT.parents[1]
    spec = _read(root / "e2e" / "accessibility.spec.js")
    assert "axe.run" in spec
    assert "['serious', 'critical']" in spec
    for view in ("radar", "approval", "audio", "subtitulos2", "scripts", "admin-users", "connectors", "errors-audit", "active-users"):
        assert f"'{view}'" in spec
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    assert "axe-core" in package["devDependencies"]
    assert "axe-core" in spec
    assert "axe.min.js" in spec
