"""Structural checks for the canonical, historical workflow fixture."""

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


class WorkflowFixtureTests(unittest.TestCase):
    def test_one_canonical_export_preserves_all_sixteen_workflows(self):
        fixture = ROOT / "examples/n8n/workflows.json"
        self.assertTrue(fixture.is_file(), "The canonical fixture must be versioned")
        workflows = json.loads(fixture.read_text(encoding="utf-8"))
        self.assertEqual(len(workflows), 16)
        self.assertEqual(len({workflow["id"] for workflow in workflows}), 16)
        self.assertTrue(all(workflow["nodes"] for workflow in workflows))
        for obsolete in (
            "local/n8n/import/workflows.json",
            "local/n8n/files/workflows-clean.json",
            "local/n8n/files/workflows-final.json",
        ):
            self.assertFalse((ROOT / obsolete).exists(), obsolete)
        compose = ROOT / "local/n8n/docker-compose.yml"
        source = "../../examples/n8n"
        self.assertIn(f"{source}:/import:ro", compose.read_text(encoding="utf-8"))
        self.assertEqual((compose.parent / source).resolve(), fixture.parent)


if __name__ == "__main__":
    unittest.main()
