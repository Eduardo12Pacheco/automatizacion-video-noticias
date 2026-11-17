"""Contract tests for the Playwright support helpers.

These helpers decide which environment file an E2E run targets and whether the
destructive reset is allowed. A regression here could point the suite at a real
installation, so the behaviour is checked through the public module.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "e2e" / "support" / "compose.js"


def run_node(script: str, env_extra: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", "/tmp"),
        "NO_COLOR": "1",
    }
    env.update(env_extra or {})
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=str(ROOT),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


class E2ESupportTests(unittest.TestCase):
    def test_reset_requires_the_explicit_opt_in(self):
        refused = run_node(
            "import { requireDisposableDemoStack } from './e2e/support/compose.js';"
            "requireDisposableDemoStack();"
        )
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("E2E_ALLOW_RESET=1", refused.stderr)

        allowed = run_node(
            "import { requireDisposableDemoStack } from './e2e/support/compose.js';"
            "requireDisposableDemoStack();",
            {"E2E_ALLOW_RESET": "1"},
        )
        self.assertEqual(allowed.returncode, 0, allowed.stderr)

    def test_editor_password_is_derived_from_the_selected_env_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "stack.env"
            env_file.write_text(
                "NEWSROOM_DEMO_PASSWORD=derived-editor-password\n",
                encoding="utf-8",
            )
            result = run_node(
                "import { editorPassword } from './e2e/support/compose.js';"
                "process.stdout.write(editorPassword());",
                {"E2E_COMPOSE_ENV": str(env_file)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "derived-editor-password")

    def test_explicit_editor_password_wins_over_the_env_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / "stack.env"
            env_file.write_text(
                "NEWSROOM_DEMO_PASSWORD=derived-editor-password\n",
                encoding="utf-8",
            )
            result = run_node(
                "import { editorPassword } from './e2e/support/compose.js';"
                "process.stdout.write(editorPassword());",
                {"E2E_COMPOSE_ENV": str(env_file), "E2E_EDITOR_PASSWORD": "explicit-password"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "explicit-password")


if __name__ == "__main__":
    unittest.main()
