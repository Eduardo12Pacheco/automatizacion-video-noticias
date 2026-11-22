"""Structural contract for the portfolio documentation deliverables."""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "README.md"
README_EN = ROOT / "README.en.md"
HERO_ES = ROOT / "docs" / "assets" / "readme" / "hero.svg"
HERO_EN = ROOT / "docs" / "assets" / "readme" / "hero.en.svg"
ARCHITECTURE = ROOT / "docs" / "ARCHITECTURE.md"
LICENSE = ROOT / "LICENSE"
ASSETS = ROOT / "ASSETS.md"
ADR_DIR = ROOT / "docs" / "adr"
DEMO_GIF = ROOT / "docs" / "images" / "demo.gif"
DEMO_MP4 = ROOT / "docs" / "images" / "demo.mp4"

FONT_SUFFIXES = (".woff2", ".woff", ".ttf", ".otf")
IGNORED_PARTS = {".git", "node_modules", ".venv", "__pycache__"}
PUBLIC_DOC_GLOBS = ("*.md",)
INTERNAL_ID = re.compile(r"\b(?:T\d{1,2}|D\d{1,2}|S(?:5|9|10|11|12)|L\d{2})\b")
ACCOUNT_PLACEHOLDERS = ("<your-account>", "<tu-cuenta>", "<your-username>", "YOUR_ACCOUNT")
GITHUB_ACCOUNT = "Eduardo12Pacheco"
REPO_NAME = "automatizacion-video-noticias"
PREVIOUS_REPO_NAME = "newsroom-video-automation"


def _public_markdown_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*.md"):
        if not path.is_file() or "odd" in path.parts or IGNORED_PARTS.intersection(path.parts):
            continue
        if "test-results" in path.parts or "playwright-report" in path.parts:
            continue
        files.append(path)
    return sorted(files)


def _relative_targets(source: str) -> list[str]:
    without_fences = re.sub(r"```.*?```", "", source, flags=re.S)
    targets = [match.group(1) for match in re.finditer(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)", without_fences)]
    targets += [match.group(1) for match in re.finditer(r"<img\s[^>]*src=[\"']([^\"']+)[\"']", without_fences)]
    return [target for target in targets if not target.startswith(("http://", "https://", "mailto:", "data:", "#"))]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _mp4_duration_seconds(path: Path) -> float:
    """Read the movie-header duration without requiring ffprobe in CI."""
    data = path.read_bytes()
    offset = data.find(b"mvhd")
    if offset < 0:
        raise AssertionError(f"{path} has no mvhd box")
    offset += 4
    version = data[offset]
    offset += 4  # version + flags
    if version == 1:
        offset += 16  # creation + modification (64-bit)
        timescale = int.from_bytes(data[offset:offset + 4], "big")
        duration = int.from_bytes(data[offset + 4:offset + 12], "big")
    else:
        offset += 8  # creation + modification (32-bit)
        timescale = int.from_bytes(data[offset:offset + 4], "big")
        duration = int.from_bytes(data[offset + 4:offset + 8], "big")
    if not timescale:
        raise AssertionError(f"{path} has a zero movie timescale")
    return duration / timescale


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
    def test_spanish_readme_is_the_default_landing_page_with_hero_and_demo(self) -> None:
        source = _read(README)
        self.assertIn("docs/assets/readme/hero.svg", source)
        self.assertIn("Automatización de video para noticias", source)
        self.assertIn('href="README.en.md"', source)
        for expected in [
            "README.en.md",
            "docs/ARCHITECTURE.md",
            "docs/INSTALL.md",
            "docs/CONNECTORS.md",
            "CONTRIBUTING.md",
            "SECURITY.md",
            "LICENSE",
            "ASSETS.md",
            "docs/images/demo.gif",
            "docs/images/demo.mp4",
            "actions/workflows/ci.yml/badge.svg",
            "```mermaid",
            "Ollama",
            "trafilatura",
            "SearXNG",
            "Postgres",
            "Piper",
            "yt-dlp",
            "Mailpit",
            "Remotion",
            "Modo demo / Demo mode",
            "modo local",
            "Historia del proyecto",
            "asistencia de IA",
            "Instalar con un comando",
            "Licencia",
        ]:
            self.assertIn(expected, source, expected)
        for honest_scope in ["portafolio", "no un sistema en producción"]:
            self.assertIn(honest_scope, source, honest_scope)
        for screenshot in [
            "docs/images/screens/approval-es-desktop.png",
            "docs/images/screens/approval-es-mobile.png",
            "docs/images/screens/radar-en-desktop.png",
            "docs/images/screens/radar-en-mobile.png",
        ]:
            self.assertIn(screenshot, source, screenshot)
        self.assertNotIn("ui-after-login.png", source)
        self.assertNotIn("ui-after-showcase.png", source)

    def test_english_readme_mirrors_the_spanish_entry_points(self) -> None:
        source = _read(README_EN)
        self.assertIn("docs/assets/readme/hero.en.svg", source)
        self.assertIn('href="README.md"', source)
        for expected in [
            "README.md",
            "docs/ARCHITECTURE.md",
            "docs/INSTALL.md",
            "docs/CONNECTORS.md",
            "CONTRIBUTING.md",
            "SECURITY.md",
            "LICENSE",
            "ASSETS.md",
            "docs/images/demo.gif",
            "docs/images/demo.mp4",
            "actions/workflows/ci.yml/badge.svg",
            "```mermaid",
            "Ollama",
            "trafilatura",
            "SearXNG",
            "Postgres",
            "Piper",
            "yt-dlp",
            "Mailpit",
            "Remotion",
            "Demo mode",
            "local",
            "Project story",
            "built with AI assistance",
            "one command",
            "commercial",
        ]:
            self.assertIn(expected, source, expected)
        for honest_scope in ["portfolio", "not a live system"]:
            self.assertIn(honest_scope, source.lower(), honest_scope)
        for screenshot in [
            "docs/images/screens/approval-es-desktop.png",
            "docs/images/screens/approval-es-mobile.png",
            "docs/images/screens/radar-en-desktop.png",
            "docs/images/screens/radar-en-mobile.png",
        ]:
            self.assertIn(screenshot, source, screenshot)
        self.assertNotIn("ui-after-login.png", source)
        self.assertNotIn("ui-after-showcase.png", source)

    def test_hero_assets_are_pure_svg_with_alt_text_for_both_languages(self) -> None:
        for path in (HERO_ES, HERO_EN):
            self.assertTrue(path.is_file(), path)
            source = _read(path)
            self.assertIn("<svg", source, path)
            self.assertIn('role="img"', source, path)
            self.assertIn("<title", source, path)
            for forbidden in ("<script", "foreignObject", "<style", "@import", "https://", 'href="http'):
                self.assertNotIn(forbidden, source, f"{path.name} contains {forbidden}")
        self.assertIn("Automatización de video para noticias", _read(HERO_ES))
        self.assertIn("Video automation for newsrooms", _read(HERO_EN))

    def test_architecture_document_and_adrs_explain_the_decisions(self) -> None:
        architecture = _read(ARCHITECTURE)
        for expected in [
            "```mermaid",
            "hexagonal",
            "puertos",
            "adaptadores",
            "packages/core",
            "packages/contracts",
            "apps/api",
            "apps/panel",
            "services/asr-worker",
            "services/tts-worker",
            "services/renderer",
            "services/channel-monitor",
            "modo demo",
            "modo local",
            "conectores",
            "privacidad",
        ]:
            self.assertIn(expected, architecture.lower(), expected)
        self.assertTrue(ADR_DIR.is_dir(), ADR_DIR)
        adrs = sorted(ADR_DIR.glob("*.md"))
        self.assertGreaterEqual(len(adrs), 7, adrs)
        combined = "\n".join(_read(adr) for adr in adrs)
        for decision in [
            "hexagonal",
            "local-first",
            "n8n",
            "vanilla",
            "demo",
            "modo local",
            "conector",
            "privacidad",
        ]:
            self.assertIn(decision, combined.lower(), decision)
        for adr in adrs:
            source = _read(adr)
            self.assertIn("## Estado", source, adr)
            self.assertIn("Aceptad", source, adr)
            self.assertIn("## Contexto", source, adr)
            self.assertIn("## Decisión", source, adr)
            self.assertIn("## Consecuencias", source, adr)

    def test_contributing_and_security_docs_are_actionable(self) -> None:
        contributing = _read(ROOT / "CONTRIBUTING.md")
        for expected in ["pnpm test:all", "install.sh", "install.ps1", "Conventional Commits"]:
            self.assertIn(expected, contributing, expected)
        self.assertIn("Co-Authored-By", contributing)
        self.assertIn("asistencia de IA", contributing)
        self.assertNotIn("any AI attribution line", contributing)
        security = _read(ROOT / "SECURITY.md")
        for expected in ["reportar", "127.0.0.1", "contraseña", "admin", "MIT"]:
            self.assertIn(expected.lower(), security.lower(), expected)

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
        self.assertIn("apps/panel/assets/fonts/inter/", source)
        self.assertIn("apps/panel/assets/fonts/jetbrains-mono/", source)
        self.assertNotIn("deliverable", source.lower())
        self.assertNotIn("must be kept next to the font", source)

    def test_recorded_demo_assets_exist_and_stay_under_the_blob_limit(self) -> None:
        for path in (DEMO_GIF, DEMO_MP4):
            self.assertTrue(path.is_file(), path)
            self.assertLess(path.stat().st_size, 5 * 1024 * 1024, path)
        self.assertLess(DEMO_GIF.stat().st_size, 1024 * 1024, "the README GIF must stay under 1 MB")
        self.assertIn(DEMO_GIF.read_bytes()[:6], (b"GIF87a", b"GIF89a"))
        self.assertEqual(DEMO_MP4.read_bytes()[4:8], b"ftyp")
        duration = _mp4_duration_seconds(DEMO_MP4)
        self.assertGreaterEqual(duration, 60, f"demo video is only {duration:.1f}s")
        self.assertLessEqual(duration, 90, f"demo video is {duration:.1f}s")

    def test_assets_manifest_describes_the_demo_recording_source(self) -> None:
        source = _read(ASSETS)
        self.assertIn("modo demo", source.lower())
        self.assertIn("tools/record-demo.mjs", source)

    def test_public_docs_use_the_published_repository_url(self) -> None:
        for path in _public_markdown_files():
            source = _read(path)
            for placeholder in ACCOUNT_PLACEHOLDERS:
                self.assertNotIn(placeholder, source, f"{path.relative_to(ROOT)} still has {placeholder}")
            self.assertNotIn(
                f"github.com/{GITHUB_ACCOUNT}/{PREVIOUS_REPO_NAME}",
                source,
                f"{path.relative_to(ROOT)} still links the previous repository name",
            )
        for path in (README, README_EN):
            source = _read(path)
            self.assertIn(f"github.com/{GITHUB_ACCOUNT}/{REPO_NAME}", source)
            self.assertIn(f"{GITHUB_ACCOUNT}/{REPO_NAME}/actions/workflows/ci.yml", source)

    def test_public_docs_do_not_expose_internal_task_or_spec_ids(self) -> None:
        for path in _public_markdown_files():
            source = _read(path)
            for match in INTERNAL_ID.finditer(source):
                line = source.count("\n", 0, match.start()) + 1
                self.fail(f"{path.relative_to(ROOT)}:{line} exposes internal id {match.group(0)!r}")

    def test_public_docs_do_not_reference_removed_process_material(self) -> None:
        removed = (
            "odd/",
            "docs/recovery",
            "openspec/",
            "sdd/",
            ".understand-anything",
            "SUBTITLES_UPLOAD_INCIDENT_INVESTIGATION",
        )
        for path in _public_markdown_files():
            source = _read(path)
            for token in removed:
                self.assertNotIn(token, source, f"{path.relative_to(ROOT)} references removed process material")

    def test_panel_docs_keep_only_the_contributor_contracts(self) -> None:
        panel_docs = ROOT / "apps" / "panel" / "docs"
        markdown = sorted(path.relative_to(panel_docs).as_posix() for path in panel_docs.rglob("*.md"))
        self.assertEqual(markdown, ["parity/contract-matrix.md", "parity/style-guards.md"])

    def test_every_public_relative_link_and_image_resolves(self) -> None:
        broken: list[str] = []
        for path in _public_markdown_files():
            for target in _relative_targets(_read(path)):
                link = target.split("#", 1)[0]
                if not link:
                    continue
                resolved = (path.parent / link).resolve()
                if not resolved.exists():
                    broken.append(f"{path.relative_to(ROOT)} -> {target}")
        self.assertEqual(broken, [], "\n".join(broken))

    def test_readmes_show_current_dark_and_light_screenshots(self) -> None:
        for path in (README, README_EN):
            source = _read(path)
            first = source.index("docs/images/screens/")
            second = source.index("docs/images/screens/", first + 1)
            self.assertEqual(
                source[first:first + len("docs/images/screens/approval-es-desktop.png")],
                "docs/images/screens/approval-es-desktop.png",
                f"{path.name} must open the gallery with the Spanish approval desktop shot",
            )
            self.assertEqual(
                source[second:second + len("docs/images/screens/approval-en-desktop.png")],
                "docs/images/screens/approval-en-desktop.png",
                f"{path.name} must put the English approval desktop shot next",
            )
            for screenshot in [
                "docs/images/screens/approval-es-desktop.png",
                "docs/images/screens/approval-es-mobile.png",
                "docs/images/screens/radar-en-desktop.png",
                "docs/images/screens/radar-en-mobile.png",
                "docs/images/screens/radar-es-desktop-light.png",
            ]:
                self.assertIn(screenshot, source, f"{path.name} is missing {screenshot}")
            target = ROOT / "docs" / "images" / "screens" / "radar-es-desktop-light.png"
            self.assertTrue(target.is_file(), target)

    def test_readmes_document_the_measured_cpu_and_gpu_timings(self) -> None:
        for path in (README, README_EN):
            source = _read(path)
            for value in ["5.2 min", "6.1 min", "22.3 s", "5.1 s", "90.1 s", "188.7 s"]:
                self.assertIn(value, source, f"{path.name} is missing timing {value}")


if __name__ == "__main__":
    unittest.main()
