"""Structural contract for the local Compose stack and its CI wiring."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "compose.yaml"
CI = ROOT / ".github" / "workflows" / "ci.yml"


class ComposeStackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.compose = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
        self.services = self.compose["services"]

    def test_required_services_and_profiles(self) -> None:
        for name in (
            "api", "panel", "demo-worker", "postgres", "searxng", "mailpit",
            "seed", "migrate", "model-init", "ollama", "tts-worker",
            "asr-worker", "n8n",
        ):
            self.assertIn(name, self.services)
        self.assertEqual(self.services["migrate"].get("profiles"), ["tools"])
        self.assertEqual(self.services["model-init"].get("profiles"), ["tools"])
        self.assertEqual(self.services["tts-worker"].get("profiles"), ["gpu"])
        self.assertEqual(self.services["asr-worker"].get("profiles"), ["gpu"])
        self.assertEqual(self.services["n8n"].get("profiles"), ["n8n"])
        for required in ("api", "panel", "demo-worker", "postgres", "searxng", "mailpit", "seed"):
            self.assertNotIn("profiles", self.services[required], required)

    def test_api_targets_the_local_compose_services(self) -> None:
        env = self.services["api"]["environment"]
        self.assertEqual(env["API_GATEWAY_TTS_TARGET"], "http://demo-worker:8088")
        self.assertEqual(env["API_GATEWAY_SUBTITLES_TARGET"], "http://demo-worker:8088")
        self.assertEqual(env["API_GATEWAY_REMOTION_TARGET"], "http://demo-worker:8088")
        self.assertEqual(env["API_GATEWAY_N8N_TARGET"], "http://n8n:5678")
        self.assertEqual(env["LLM"], "${LLM:-ollama}")
        self.assertIn("DATABASE_URL", env)

    def test_seed_and_one_shot_services_are_bounded(self) -> None:
        self.assertEqual(self.services["seed"].get("restart"), "no")
        self.assertEqual(self.services["migrate"].get("restart"), "no")
        self.assertEqual(self.services["model-init"].get("restart"), "no")
        self.assertEqual(self.services["seed"]["command"], ["node", "scripts/seed-demo.js"])
        self.assertEqual(self.services["migrate"]["command"], ["node", "packages/data/scripts/migrate.js"])

    def test_images_and_compatibility_alias_exist(self) -> None:
        for path in (
            ROOT / "apps/api/Dockerfile",
            ROOT / "apps/panel/Dockerfile",
            ROOT / "services/demo-worker/Dockerfile",
            ROOT / "infra/models/Dockerfile",
            ROOT / "docker-compose.yml",
        ):
            self.assertTrue(path.is_file(), str(path))
        alias = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        self.assertIn("include:", alias)
        self.assertIn("compose.yaml", alias)

    def test_env_template_has_generated_demo_password_and_no_real_keys(self) -> None:
        env = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("NEWSROOM_DEMO_PASSWORD=__GENERATE__", env)
        self.assertIn("SEARXNG_SECRET=__GENERATE__", env)
        self.assertNotRegex(env, re.compile(r"(sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,})"))

    def test_ci_runs_lint_suites_and_the_browser_happy_path(self) -> None:
        workflow = yaml.safe_load(CI.read_text(encoding="utf-8"))
        jobs = workflow["jobs"]
        for name in ("lint", "js-suites", "panel-suite", "python-suites", "compose", "e2e"):
            self.assertIn(name, jobs)
        e2e = str(jobs["e2e"])
        self.assertIn("docker compose up", e2e)
        self.assertIn("playwright test", e2e)
        self.assertIn("docker compose down -v", e2e)


if __name__ == "__main__":
    unittest.main()
