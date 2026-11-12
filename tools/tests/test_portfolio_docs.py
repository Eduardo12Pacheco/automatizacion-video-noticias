"""Structural contract for the T9 portfolio documentation deliverables."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "README.md"
README_ES = ROOT / "README.es.md"
ARCHITECTURE = ROOT / "docs" / "ARCHITECTURE.md"
LICENSE = ROOT / "LICENSE"
ASSETS = ROOT / "ASSETS.md"
ADR_DIR = ROOT / "docs" / "adr"
DEMO_GIF = ROOT / "docs" / "images" / "demo.gif"
DEMO_MP4 = ROOT / "docs" / "images" / "demo.mp4"

FONT_SUFFIXES = (".woff2", ".woff", ".ttf", ".otf")
IGNORED_PARTS = {".git", "node_modules", ".venv", "__pycache__"}


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _font_directories() -> set[Path]:
    directories: set[Path] = set()
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in FONT_SUFFIXES:
            continue
        if IGNORED_PARTS.intersection(path.parts):
            continue
        directories.add(path.parent)
    return directories


class PortfolioDocsTests(unittest.TestCase):
    def test_readme_is_a_portfolio_pitch_with_demo_diagram_and_local_first_table(self) -> None:
        source = _read(README)
        self.assertTrue(source.startswith("# Newsroom Video Automation"))
        for expected in [
            "README.es.md",
            "docs/ARCHITECTURE.md",
            "docs/INSTALL.md",
            "LICENSE",
            "ASSETS.md",
            "docs/images/demo.gif",
            "docs/images/demo.mp4",
            "```mermaid",
            "Ollama",
            "trafilatura",
            "SearXNG",
            "Postgres",
            "Piper",
            "yt-dlp",
            "Mailpit",
            "Remotion",
            "commercial",
            "built with AI assistance",
            "one command",
        ]:
            self.assertIn(expected, source, expected)
        for honest_scope in ["portfolio", "not a live system"]:
            self.assertIn(honest_scope, source.lower(), honest_scope)

    def test_spanish_readme_mirrors_the_portfolio_entry_points(self) -> None:
        source = _read(README_ES)
        self.assertTrue(source.startswith("# Newsroom Video Automation"))
        for expected in [
            "README.md",
            "docs/ARCHITECTURE.md",
            "docs/INSTALL.md",
            "docs/images/demo.gif",
            "Arquitectura",
            "Local",
            "Licencia",
        ]:
            self.assertIn(expected, source, expected)

    def test_architecture_document_and_adrs_explain_the_decisions(self) -> None:
        architecture = _read(ARCHITECTURE)
        for expected in [
            "```mermaid",
            "Hexagonal",
            "ports",
            "adapters",
            "packages/core",
            "packages/contracts",
            "apps/api",
            "apps/panel",
            "services/asr-worker",
            "services/tts-worker",
            "services/renderer",
            "services/channel-monitor",
        ]:
            self.assertIn(expected, architecture, expected)
        self.assertTrue(ADR_DIR.is_dir(), ADR_DIR)
        adrs = sorted(ADR_DIR.glob("*.md"))
        self.assertGreaterEqual(len(adrs), 4, adrs)
        combined = "\n".join(_read(adr) for adr in adrs)
        for decision in [
            "hexagonal",
            "local-first",
            "n8n",
            "vanilla",
        ]:
            self.assertIn(decision, combined.lower(), decision)
        for adr in adrs:
            source = _read(adr)
            self.assertIn("## Status", source, adr)
            self.assertIn("Accepted", source, adr)
            self.assertIn("## Context", source, adr)
            self.assertIn("## Decision", source, adr)
            self.assertIn("## Consequences", source, adr)

    def test_license_is_mit_for_eduardo_pacheco(self) -> None:
        source = _read(LICENSE)
        self.assertIn("MIT License", source)
        self.assertIn("Copyright (c) 2026 Eduardo Pacheco", source)
        self.assertIn("Permission is hereby granted, free of charge", source)
        self.assertIn('THE SOFTWARE IS PROVIDED "AS IS"', source)

    def test_every_shipped_font_has_an_ofl_license_next_to_it(self) -> None:
        directories = _font_directories()
        self.assertTrue(directories, "expected at least one shipped font")
        for directory in sorted(directories):
            license_path = directory / "OFL.txt"
            self.assertTrue(license_path.is_file(), license_path)
            source = _read(license_path)
            self.assertIn("SIL OPEN FONT LICENSE Version 1.1", source, license_path)
            self.assertIn("Copyright", source, license_path)

    def test_assets_manifest_records_font_licenses_and_the_recorded_demo(self) -> None:
        source = _read(ASSETS)
        self.assertIn("OFL.txt", source)
        self.assertIn("docs/images/demo.gif", source)
        self.assertNotIn("T9 deliverable", source)
        self.assertNotIn("must be kept next to the font", source)

    def test_recorded_demo_assets_exist_and_stay_under_the_blob_limit(self) -> None:
        for path in (DEMO_GIF, DEMO_MP4):
            self.assertTrue(path.is_file(), path)
            self.assertLess(path.stat().st_size, 5 * 1024 * 1024, path)
        self.assertIn(DEMO_GIF.read_bytes()[:6], (b"GIF87a", b"GIF89a"))
        self.assertEqual(DEMO_MP4.read_bytes()[4:8], b"ftyp")


if __name__ == "__main__":
    unittest.main()
