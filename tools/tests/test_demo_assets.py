"""Structural checks for the generated fictional brand asset set."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "examples" / "brand"
RENDERER = ROOT / "services" / "renderer"
PANEL = ROOT / "apps" / "panel"

CANONICAL = [
    "logo-demo.webm",
    "logo-demo-green.mp4",
    "final-demo.mp4",
    "final-demo.webm",
    "particle-1.webm",
    "particle-2.webm",
    "overlay-1.webm",
    "overlay-2.webm",
    "transition-1.mp4",
    "sfx/whip.wav",
    "sfx/whoosh.wav",
    "sfx/sting.wav",
    "fonts/Demo-Display.woff2",
]

MIRRORS = [
    RENDERER / "assets" / "overlays" / "logo-primary.webm",
    RENDERER / "assets" / "overlays" / "logo-green.mp4",
    RENDERER / "assets" / "overlays" / "outro-final.mp4",
    RENDERER / "assets" / "overlays" / "particle-1.webm",
    RENDERER / "assets" / "overlays" / "overlay-layer-01.webm",
    RENDERER / "public" / "fonts" / "display" / "Demo-Display.woff2",
    RENDERER / "public" / "sfx" / "sound-demo.wav",
    PANEL / "assets" / "logo-primary.webm",
    PANEL / "assets" / "logo-primary.webm",
    PANEL / "assets" / "particle-1.webm",
    PANEL / "assets" / "fonts" / "display" / "Demo-Display.woff2",
]


class DemoAssetTests(unittest.TestCase):
    def test_generator_is_versioned_and_documented(self):
        script = ROOT / "tools" / "assets" / "generate_demo_assets.py"
        self.assertTrue(script.is_file())
        source = script.read_text(encoding="utf-8")
        self.assertIn("Demo Sports News", source)
        self.assertIn("map_metadata", source)
        assets = (ROOT / "ASSETS.md").read_text(encoding="utf-8")
        self.assertIn("generate_demo_assets.py", assets)
        self.assertIn("Demo Sports News", assets)
        self.assertIn("OFL-1.1", assets)

    def test_canonical_assets_exist_are_small_and_are_real_media(self):
        for relative in CANONICAL:
            path = BRAND / relative
            self.assertTrue(path.is_file(), relative)
            self.assertLess(path.stat().st_size, 5 * 1024 * 1024, relative)
        self.assertEqual((BRAND / "fonts" / "Demo-Display.woff2").read_bytes()[:4], b"wOF2")
        self.assertEqual((BRAND / "sfx" / "whip.wav").read_bytes()[:4], b"RIFF")

    def test_runtime_mirrors_are_generated_from_the_canonical_set(self):
        sync_script = ROOT / "tools" / "assets" / "sync-runtime-assets.mjs"
        self.assertTrue(sync_script.is_file())
        source = sync_script.read_text(encoding="utf-8")
        for path in MIRRORS:
            relative = path.relative_to(ROOT).as_posix()
            self.assertIn(relative, source, f"{relative} must be materialized by the sync script")


if __name__ == "__main__":
    unittest.main()
