"""Contract for the admin connectors screen."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
TEMPLATES = ROOT / "js" / "modules" / "app-shell" / "views" / "templates"
FEATURE = ROOT / "js" / "modules" / "features" / "connectors"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


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
