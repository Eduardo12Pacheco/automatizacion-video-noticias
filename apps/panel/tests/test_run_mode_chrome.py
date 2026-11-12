"""D10 run-mode chrome: the demo run must be visible in the panel (T17)."""
from pathlib import Path
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_demo_mode_has_exactly_one_indicator_wired_to_the_bootstrap():
    index = _read(ROOT / "index.html")
    runtime = _read(ROOT / "js" / "modules" / "app-shell" / "runtime.js")
    showcase = _read(ROOT / "js" / "modules" / "core" / "showcase" / "showcase-mode.js")

    assert 'id="runModeBadge"' in index
    assert 'data-i18n="mode.demoBadge"' in index
    # T29: the header badge is the only demo indicator on screen.
    assert 'id="runModeBanner"' not in index
    assert "showcase-badge" not in showcase
    assert "bootstrap.run_mode === 'demo'" in runtime
    assert "getAttribute?.('data-showcase') === 'true'" in runtime
    assert "run_mode: 'demo'" in showcase


def test_demo_mode_copy_exists_in_both_catalogs():
    for language in ("es", "en"):
        catalog = json.loads(_read(ROOT / "js" / "modules" / "core" / "i18n" / f"{language}.json"))
        assert catalog["mode.demoBadge"].strip()
        assert "demo" in catalog["mode.demoBadge"].lower()


def test_run_mode_chrome_uses_semantic_tokens():
    base = _read(ROOT / "styles" / "base.css")
    start = base.index(".run-mode-badge")
    block = base[start:]
    assert "var(--accent)" in block
    assert "var(--surface-0)" in block
    assert "var(--space-" in block
    assert not any(f"#{hex_value}" in block for hex_value in ("ffffff", "000000", "e8e8e8"))


def test_runtime_parses_after_adding_the_mode_chrome():
    result = subprocess.run(
        ["node", "--check", str(ROOT / "js" / "modules" / "app-shell" / "runtime.js")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
