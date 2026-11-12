"""S5 UI refresh contract (T7).

These checks replace the older grep-only web.pen snapshots: they guard the
S5 acceptance items (typography, buttons, tokens, dialogs, i18n, navigation,
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


def test_button_variants_and_destructive_actions():
    buttons = _read(BUTTONS)
    for fragment in [
        "button.primary", "button.secondary", "button.ghost", "button.danger",
        "border: 1px solid var(--border-strong);",
        "background: var(--accent);",
        ":focus-visible",
    ]:
        assert fragment in buttons

    index = _read(INDEX)
    assert 'class="danger button-icon script-remove-button"' in index
    assert '<span data-i18n="approval.remove">Quitar</span>' in index
    approval_area = index.split('id="viewApproval"', 1)[1].split('id="viewScripts"', 1)[0]
    editor_area = approval_area.split('class="editor-actions approval-editor-actions"', 1)[1]
    assert editor_area.count('class="primary') == 1
    assert 'id="publishDraftBtn" class="primary' in approval_area
    assert 'id="downloadDraftBtn" class="secondary' in approval_area

    scripts = _read(TEMPLATES / "scripts-view.js")
    assert 'id="videoProjectsNewBtn" class="primary' in scripts
    assert 'id="videoProjectsRefreshBtn" class="ghost' in scripts

    subtitles = _read(TEMPLATES / "subtitles-view.js")
    assert 'id="subtitle2ReadyBtn" class="primary"' in subtitles
    assert 'id="subtitle2DownloadBtn" class="secondary"' in subtitles


def test_dialog_pattern_title_close_and_right_aligned_footer():
    index = _read(INDEX)
    dialogs = _read(DIALOGS)

    assert 'class="dialog-close"' in index
    assert index.count('class="dialog-close"') >= 5
    assert 'class="dialog-actions"' in index
    assert ".dialog-actions" in dialogs
    assert "justify-content: flex-end;" in dialogs
    assert "id=\"queueDialog\"" not in index
    assert "id=\"scriptEditorDialog\"" not in index

    publish_dialog = index.split('id="publishConfirmDialog"', 1)[1].split("</dialog>", 1)[0]
    assert publish_dialog.index('id="cancelPublishBtn"') < publish_dialog.index('id="confirmPublishBtn"')


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


def test_pipeline_navigation_and_admin_views():
    index = _read(INDEX)
    order = [index.index(f'data-view="{view}"') for view in ["radar", "approval", "audio", "subtitulos2", "scripts"]]
    assert order == sorted(order), "navigation must follow the pipeline order"
    assert 'id="settingsBtn"' in index.split('class="sidebar-foot"', 1)[1]
    for view in ["errors-audit", "active-users", "admin-users"]:
        assert f'data-view="{view}"' in index
    assert 'data-admin-only' in index
    assert 'id="viewAdminUsers"' in index

    navigation = _read(ROOT / "js" / "modules" / "app-shell" / "navigation.js")
    assert "'admin-users'" in navigation


def test_accessibility_and_three_breakpoints():
    base = _read(STYLES / "base.css")
    responsive = _read(RESPONSIVE)
    tokens = _read(TOKENS)

    assert ":focus-visible" in base
    assert "outline: 2px solid var(--accent);" in base
    assert "prefers-reduced-motion: reduce" in base
    assert "prefers-reduced-motion: no-preference" in base
    assert "--muted-2: var(--text-3);" in tokens
    # Two media steps define the three layout ranges: >=1200, 860-1199 and <860.
    widths = set(re.findall(r"@media \(max-width: (\d+)px\)", "\n".join(
        path.read_text() for path in STYLES.rglob("*.css")
    )))
    assert widths == {"1199", "859"}, widths
    assert responsive.count("@media (max-width:") == 3
    assert "@media (max-width: 1199px)" in responsive
    assert "@media (max-width: 859px)" in responsive
    # The rail becomes a top bar with a menu button below 860px.
    narrow = responsive.split("@media (max-width: 859px)", 1)[1]
    assert "position: sticky;" in narrow
    assert "flex-direction: row;" in narrow
    assert "mobile-nav-toggle" in narrow
    assert "is-nav-open .sidebar-nav" in narrow
    assert 'id="mobileNavToggle"' in _read(INDEX)
    assert "aria-controls=\"sidebarNav\"" in _read(INDEX)


def test_showcase_mode_is_wired_with_fictional_data():
    showcase = _read(ROOT / "js" / "modules" / "core" / "showcase" / "showcase-mode.js")
    main = _read(ROOT / "js" / "main.js")
    assert "installShowcaseMode" in main
    assert "isShowcaseRequested" in main
    assert "PENDING_ITEMS" in showcase
    assert "demo@example.local" not in showcase  # no real user data
    assert "admin@example.local" in showcase

    script = r"""
import { installShowcaseMode, isShowcaseRequested } from './js/modules/core/showcase/showcase-mode.js';
if (!isShowcaseRequested({ locationLike: { search: '?showcase=1' }, storage: { getItem: () => null } })) {
  throw new Error('showcase query not detected');
}
const session = installShowcaseMode({ locationLike: { origin: 'http://localhost:8080', search: '?showcase=1' }, windowRef: { document: null } });
if (session.roles[0] !== 'admin') throw new Error('showcase session is not admin');
const response = await globalThis.fetch('http://localhost:8080/panel/session');
const payload = await response.json();
if (payload.roles[0] !== 'admin') throw new Error('showcase fetch interceptor drift');
const pending = await (await globalThis.fetch('http://localhost:8080/panel/read-models/approval/pending')).json();
if (pending.items.length < 3) throw new Error('showcase seed missing');
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_admin_users_screen_uses_the_admin_api_and_no_hardcoded_password():
    template = _read(TEMPLATES / "admin-users-view.js")
    api = _read(ROOT / "js" / "modules" / "features" / "admin-users" / "api.js")
    controller = _read(ROOT / "js" / "modules" / "features" / "admin-users" / "controller.js")
    bootstrap = _read(ROOT / "js" / "modules" / "core" / "bootstrap.js")

    assert 'id="adminUsersForm"' in template
    assert 'id="adminUsersList"' in template
    assert "/panel/admin/users" in api
    assert "/panel/admin/roles" in api
    assert "createUser" in controller and "updateUser" in api
    assert "paneladmin" not in bootstrap
    assert "Guiones2026" not in bootstrap
    assert "isValidCredentials({ user, pass" not in bootstrap
