"""Structural checks for the historical export and the supported n8n examples."""

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class WorkflowFixtureTests(unittest.TestCase):
    def test_one_canonical_legacy_export_preserves_all_sixteen_workflows(self):
        fixture = ROOT / "examples/legacy-n8n/workflows.json"
        self.assertTrue(fixture.is_file(), "The canonical legacy export must be versioned")
        workflows = json.loads(fixture.read_text(encoding="utf-8"))
        self.assertEqual(len(workflows), 16)
        self.assertEqual(len({workflow["id"] for workflow in workflows}), 16)
        self.assertTrue(all(workflow["nodes"] for workflow in workflows))
        for obsolete in (
            "examples/n8n/workflows.json",
            "infra/n8n/import/workflows.json",
            "infra/n8n/files/workflows-clean.json",
            "infra/n8n/files/workflows-final.json",
        ):
            self.assertFalse((ROOT / obsolete).exists(), obsolete)

    def test_supported_examples_are_slim_and_path_aligned(self):
        workflows_dir = ROOT / "infra/n8n/workflows"
        expected = {
            "discover-cron.json": "/jobs/discover",
            "job-completed-notification.json": "job-completed",
        }
        for filename, marker in expected.items():
            path = workflows_dir / filename
            self.assertTrue(path.is_file(), f"missing {filename}")
            text = path.read_text(encoding="utf-8")
            self.assertIn(marker, text)
            workflow = json.loads(text)
            self.assertLessEqual(len(workflow["nodes"]), 5, f"{filename} should stay slim")
            self.assertFalse(workflow.get("active"), f"{filename} must import inactive")
            self.assertNotIn("supabase", text.lower(), f"{filename} still targets Supabase")
            self.assertNotIn("firecrawl", text.lower(), f"{filename} still targets Firecrawl")

    def test_legacy_export_is_never_mounted_or_imported_by_compose(self):
        for compose in ("compose.yaml", "infra/n8n/docker-compose.yml"):
            text = (ROOT / compose).read_text(encoding="utf-8")
            self.assertNotIn("examples/legacy-n8n", text, f"{compose} mounts the legacy export")
            self.assertNotIn("examples/n8n", text, f"{compose} mounts the old export")

        compose = ROOT / "infra/n8n/docker-compose.yml"
        source = "./workflows"
        text = compose.read_text(encoding="utf-8")
        self.assertIn(f"{source}:/workflows:ro", text)
        self.assertEqual((compose.parent / source).resolve(), (ROOT / "infra/n8n/workflows").resolve())


if __name__ == "__main__":
    unittest.main()
