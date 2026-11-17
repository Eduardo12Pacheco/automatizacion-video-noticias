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
            "asr-worker", "subtitles", "renderer", "n8n",
        ):
            self.assertIn(name, self.services)
        self.assertEqual(self.services["migrate"].get("profiles"), ["tools"])
        self.assertEqual(self.services["model-init"].get("profiles"), ["tools"])
        self.assertEqual(self.services["tts-worker"].get("profiles"), ["local", "gpu"])
        self.assertEqual(self.services["asr-worker"].get("profiles"), ["local", "gpu"])
        self.assertEqual(self.services["subtitles"].get("profiles"), ["local", "gpu"])
        self.assertEqual(self.services["renderer"].get("profiles"), ["local", "gpu"])
        self.assertEqual(self.services["ollama"].get("profiles"), ["local", "gpu"])
        self.assertEqual(self.services["n8n"].get("profiles"), ["n8n"])
        for required in ("api", "panel", "demo-worker", "postgres", "searxng", "mailpit", "seed"):
            self.assertNotIn("profiles", self.services[required], required)

    def test_panel_serves_es_modules_with_a_javascript_content_type(self) -> None:
        nginx = (ROOT / "infra" / "panel" / "nginx.conf").read_text(encoding="utf-8")
        self.assertIn(r"\.mjs$", nginx)
        self.assertIn("application/javascript", nginx)

    def test_api_lets_the_run_mode_own_the_worker_targets(self) -> None:
        env = self.services["api"]["environment"]
        # The gateway resolves demo/local worker targets from
        # NEWSROOM_MODE; a hard-coded Compose target would defeat the mode.
        self.assertNotIn("API_GATEWAY_TTS_TARGET", env)
        self.assertNotIn("API_GATEWAY_SUBTITLES_TARGET", env)
        self.assertNotIn("API_GATEWAY_REMOTION_TARGET", env)
        self.assertNotIn("API_GATEWAY_APPROVAL_TARGET", env)
        self.assertEqual(env["API_GATEWAY_N8N_TARGET"], "http://n8n:5678")
        self.assertEqual(env["NEWSROOM_MODE"], "${NEWSROOM_MODE:-demo}")
        self.assertEqual(env["LLM"], "${LLM:-ollama}")
        self.assertIn("DATABASE_URL", env)

    def test_e2e_fixture_service_is_opt_in_and_serves_three_articles(self) -> None:
        fixtures = self.services["e2e-fixtures"]
        self.assertEqual(fixtures.get("profiles"), ["e2e"])
        self.assertNotIn("ports", fixtures)
        feed = (ROOT / "infra" / "e2e" / "fixtures" / "discovery.xml").read_text(encoding="utf-8")
        self.assertEqual(len(re.findall(r"<item>", feed)), 3)
        for page in ("aurenia-mediocampo.html", "montelia-capitan.html", "valdoria-lista.html"):
            self.assertTrue((ROOT / "infra" / "e2e" / "fixtures" / page).is_file(), page)
        env = self.services["api"]["environment"]
        self.assertEqual(env["NEWS_DISCOVERY_FEED_URL"], "${NEWS_DISCOVERY_FEED_URL:-}")
        self.assertEqual(env["NEWS_DISCOVERY_PLAYERS"], "${NEWS_DISCOVERY_PLAYERS:-}")

    def test_seed_and_one_shot_services_are_bounded(self) -> None:
        self.assertEqual(self.services["seed"].get("restart"), "no")
        self.assertEqual(self.services["migrate"].get("restart"), "no")
        self.assertEqual(self.services["model-init"].get("restart"), "no")
        self.assertEqual(self.services["seed"]["command"], ["node", "scripts/seed-demo.js"])
        self.assertEqual(self.services["migrate"]["command"], ["node", "packages/data/scripts/migrate.js"])

    def test_images_exist_and_the_duplicate_compose_alias_is_gone(self) -> None:
        for path in (
            ROOT / "apps/api/Dockerfile",
            ROOT / "apps/panel/Dockerfile",
            ROOT / "services/demo-worker/Dockerfile",
            ROOT / "services/subtitles/Dockerfile",
            ROOT / "services/renderer/Dockerfile",
            ROOT / "infra/models/Dockerfile",
        ):
            self.assertTrue(path.is_file(), str(path))
        self.assertFalse((ROOT / "docker-compose.yml").exists(), "compose.yaml is the only root compose file")

    def test_env_template_has_generated_demo_password_and_no_real_keys(self) -> None:
        env = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("NEWSROOM_DEMO_PASSWORD=__GENERATE__", env)
        self.assertIn("SEARXNG_SECRET=__GENERATE__", env)
        self.assertNotRegex(env, re.compile(r"(sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,})"))

    def test_published_ports_bind_to_loopback_by_default(self) -> None:
        for name, service in self.services.items():
            for entry in service.get("ports") or []:
                self.assertIsInstance(entry, str, f"{name} uses a non-string port mapping")
                self.assertTrue(
                    entry.startswith("${NEWSROOM_BIND:-127.0.0.1}:"),
                    f"{name} must bind to ${{NEWSROOM_BIND:-127.0.0.1}}, got {entry}",
                )

    def test_panel_proxy_overwrites_the_forwarded_for_header(self) -> None:
        nginx = (ROOT / "infra" / "panel" / "nginx.conf").read_text(encoding="utf-8")
        self.assertIn("proxy_set_header X-Forwarded-For $remote_addr;", nginx)
        self.assertNotIn("proxy_add_x_forwarded_for", nginx)

    def test_internal_services_are_not_published_by_default(self) -> None:
        for name in ("postgres", "searxng", "mailpit", "ollama", "n8n"):
            self.assertNotIn("ports", self.services[name], name)

        debug_path = ROOT / "infra" / "compose" / "compose.debug.yaml"
        self.assertTrue(debug_path.is_file(), str(debug_path))
        debug = yaml.safe_load(debug_path.read_text(encoding="utf-8"))["services"]
        for name in ("postgres", "searxng", "mailpit", "ollama", "n8n"):
            # The override file is the opt-in, not a profile: profiling these
            # services would remove them from the base project while other
            # services still depend on them.
            self.assertNotIn("profiles", debug[name], name)
            self.assertIn("ports", debug[name], name)
            for entry in debug[name]["ports"]:
                self.assertTrue(entry.startswith("${NEWSROOM_BIND:-127.0.0.1}:"), entry)

    def test_local_workers_read_the_env_names_they_actually_use(self) -> None:
        asr = self.services["asr-worker"]["environment"]
        self.assertIn("TRANSCRIPT_SERVICE_WHISPER_MODEL_PATH", asr)
        self.assertIn("TRANSCRIPT_SERVICE_DEVICE", asr)
        self.assertIn("TRANSCRIPT_SERVICE_COMPUTE_TYPE", asr)
        self.assertIn("TRANSCRIPT_SERVICE_API_KEY", asr)
        subtitles = self.services["subtitles"]["environment"]
        self.assertEqual(subtitles["ASR_WORKER_URL"], "http://asr-worker:8765")
        self.assertIn("SUBTITLES_REMOTE_API_KEY", subtitles)
        tts = self.services["tts-worker"]["environment"]
        self.assertNotIn("TTS_ORCH_FRONTEND_API_KEY", tts)
        self.assertIn("TTS_WORKER_INTERNAL_TOKEN", tts)
        self.assertIn("TTS_WORKER_FRONTEND_API_KEY", tts)
        self.assertIn("TTS_WORKER_BASIC_USER", tts)
        self.assertIn("TTS_WORKER_BASIC_PASS", tts)
        self.assertEqual(tts["TTS_WORKER_INTERNAL_URL"], "http://127.0.0.1:8767")
        renderer = self.services["renderer"]["environment"]
        self.assertEqual(renderer["RENDER_SERVER_PORT"], "3042")
        self.assertEqual(renderer["RENDERER_PROFILE"], "${RENDERER_PROFILE:-local}")
        approval_editor = self.services["approval-editor"]["environment"]
        self.assertEqual(approval_editor["APPROVAL_EDITOR_RENDER_ADAPTER"], "${APPROVAL_EDITOR_RENDER_ADAPTER:-http}")
        self.assertIn("APPROVAL_EDITOR_RENDERER_URL", approval_editor)


    def test_worker_healthchecks_and_pinned_images(self) -> None:
        for name in ("asr-worker", "tts-worker", "channel-monitor", "searxng", "renderer", "approval-editor"):
            self.assertIn("healthcheck", self.services[name], f"{name} needs a healthcheck")
        for name in ("searxng", "mailpit", "ollama", "minio", "minio-init"):
            image = self.services[name]["image"]
            self.assertNotIn(":latest", image, f"{name} must be pinned to an explicit tag")
            self.assertRegex(image, r":[^:\s]+$", f"{name} needs an explicit tag")

    def test_gpu_overlay_reserves_devices_and_selects_qwen(self) -> None:
        overlay_doc = yaml.safe_load((ROOT / "infra" / "compose" / "compose.gpu.yaml").read_text(encoding="utf-8"))
        overlay = overlay_doc["services"]
        for name in ("ollama", "asr-worker", "tts-worker"):
            self.assertEqual(overlay[name].get("gpus"), "all", name)
        self.assertEqual(overlay["asr-worker"]["environment"]["TRANSCRIPT_SERVICE_DEVICE"], "cuda")
        self.assertEqual(overlay["tts-worker"]["environment"]["TTS_WORKER_ENGINE"], "qwen")
        # The GPU voice engine needs the Qwen extra, a local checkpoint volume
        # and a reference voice that the model can clone.
        self.assertEqual(overlay["tts-worker"]["build"]["args"]["TTS_EXTRAS"], "piper,gpu")
        self.assertEqual(overlay["tts-worker"]["environment"]["TTS_WORKER_MODEL"], "/models/qwen-tts")
        self.assertIn("newsroom_qwen_models:/models/qwen-tts", overlay["tts-worker"]["volumes"])
        self.assertIn("newsroom_qwen_models", overlay_doc["volumes"])
        # model-init downloads that checkpoint in the same explicit step.
        self.assertEqual(overlay["model-init"]["environment"]["TTS_WORKER_ENGINE"], "qwen")
        self.assertIn("newsroom_qwen_models:/models/qwen-tts", overlay["model-init"]["volumes"])
        # Ollama must unload before Qwen needs the same 8 GB card. The API
        # sends keep_alive per request, so the override has to cover it too.
        self.assertEqual(overlay["ollama"]["environment"]["OLLAMA_KEEP_ALIVE"], "${OLLAMA_GPU_KEEP_ALIVE:-0s}")
        self.assertEqual(overlay["api"]["environment"]["OLLAMA_KEEP_ALIVE"], "${OLLAMA_GPU_KEEP_ALIVE:-0s}")
        for name in ("voz.wav", "voz.txt"):
            self.assertGreater((ROOT / "services" / "tts-worker" / "refs" / name).stat().st_size, 0, name)

    def test_ollama_never_pulls_models_from_its_container_command(self) -> None:
        ollama = self.services["ollama"]
        self.assertEqual(ollama["command"], ["serve"])
        self.assertNotIn("ollama pull", str(ollama))
        self.assertEqual(ollama["environment"]["OLLAMA_KEEP_ALIVE"], "${OLLAMA_KEEP_ALIVE:-30s}")

    def test_internal_secrets_have_no_weak_defaults(self) -> None:
        text = COMPOSE.read_text(encoding="utf-8")
        self.assertIn("${POSTGRES_PASSWORD:?run ./install.sh first}", text)
        self.assertIn("${SEARXNG_SECRET:?run ./install.sh first}", text)
        self.assertIn("${N8N_ENCRYPTION_KEY:?run ./install.sh first}", text)
        self.assertIn("${API_GATEWAY_RADAR_API_KEY:?run ./install.sh first}", text)
        self.assertNotIn("POSTGRES_PASSWORD:-", text)
        self.assertNotIn("local-change-me", text)
        self.assertNotIn("newsroom-local-search", text)

    def test_env_template_documents_the_loopback_bind_and_proxy_trust(self) -> None:
        env = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("NEWSROOM_BIND=127.0.0.1", env)
        self.assertIn("TRUSTED_PROXY_CIDRS=", env)
        self.assertIn("API_GATEWAY_HOST=0.0.0.0", env)
        self.assertNotIn("API_GATEWAY_PANEL_USER=", env)
        self.assertNotIn("API_GATEWAY_PANEL_PASS=", env)

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
