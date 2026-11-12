"""Contract for the admin connectors screen added in T18."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
TEMPLATES = ROOT / "js" / "modules" / "app-shell" / "views" / "templates"
FEATURE = ROOT / "js" / "modules" / "features" / "connectors"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_connectors_view_is_admin_only_and_reachable_from_settings():
    index = _read(INDEX)
    admin_group = index.split('data-admin-only', 1)[1].split('</nav>', 1)[0]
    assert 'data-view="connectors"' in admin_group
    assert 'id="viewConnectors"' in index
    assert 'id="openConnectorsBtn"' in index
    settings = index.split('id="settingsDialog"', 1)[1].split('</dialog>', 1)[0]
    assert 'id="openConnectorsBtn"' in settings

    navigation = _read(ROOT / "js" / "modules" / "app-shell" / "navigation.js")
    assert "'connectors'" in navigation
    views_navigation = _read(ROOT / "js" / "modules" / "app-shell" / "views" / "navigation.js")
    assert "connectorsViewHTML" in views_navigation
    assert "createConnectorsState" in _read(ROOT / "js" / "modules" / "app-shell" / "composition.js")


def test_connectors_screen_uses_the_admin_api_and_has_a_test_button():
    template = _read(TEMPLATES / "connectors-view.js")
    api = _read(FEATURE / "api.js")
    controller = _read(FEATURE / "controller.js")
    render = _read(FEATURE / "render.js")

    assert 'id="connectorsList"' in template
    assert 'id="connectorsRefreshBtn"' in template
    assert "/panel/connectors" in api
    assert "/test" in api
    assert "testConnector" in controller
    assert "data-connector-test" in render
    assert "testable" in render
    assert "status-chip--error" in render


def test_connectors_catalogs_cover_every_connector_id_in_both_languages():
    es = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "es.json"))
    en = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / "en.json"))
    ids = [
        "repository", "blob-storage", "news-source", "article-extractor", "llm",
        "image-search", "tts", "asr", "translation", "video-renderer", "channel-feed",
        "media-download", "document-export", "workflow", "notification", "auth",
    ]
    for language in (es, en):
        for connector_id in ids:
            assert f"connectors.name.{connector_id}" in language
        for status in ("local", "configured", "disabled", "error"):
            assert f"connectors.status.{status}" in language


def test_connectors_css_uses_tokens_and_no_raw_hex_colours():
    css = _read(ROOT / "styles" / "features" / "connectors.css")
    assert ".connectors-grid" in css
    assert "var(--surface-soft)" in css
    assert "var(--danger-soft)" in css
    assert "#" not in css
