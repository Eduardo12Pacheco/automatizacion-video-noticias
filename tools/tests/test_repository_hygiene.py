"""Keep implementation history artifacts out of the product tree."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class RepositoryHygieneTests(unittest.TestCase):
    def test_obsolete_agent_and_design_artifacts_are_not_shipped(self):
        for name in (
            "context.md",
            "SUBTITLES_UPLOAD_INCIDENT_INVESTIGATION.md",
            ".understand-anything",
            "sdd",
            "openspec",
            "08-Workspace-Docs",
            "04-Image-Downloader",
            "07-Supabase",
        ):
            self.assertFalse((ROOT / name).exists(), name)
        for source in ("apps/panel", "services/renderer", "apps", "services"):
            folder = ROOT / source
            self.assertEqual(list(folder.rglob("AGENTS.md")), [], source)
            self.assertEqual(list(folder.rglob("openspec")), [], source)


if __name__ == "__main__":
    unittest.main()
