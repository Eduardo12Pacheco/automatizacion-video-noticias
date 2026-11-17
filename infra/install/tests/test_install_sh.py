#!/usr/bin/env python3
"""Behaviour tests for install.sh through its public command line.

A deterministic `docker` stand-in in fake-bin records the compose calls, so the
suite exercises the real script (argument parsing, .env generation, state,
idempotency and uninstall) without pulling images or touching the host.
"""
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
INSTALL_SH = REPO_ROOT / "install.sh"
FAKE_BIN = Path(__file__).resolve().parent / "fake-bin"
BROKEN_BIN = Path(__file__).resolve().parent / "broken-bin"
GENERATED_TOKEN = re.compile(r"__GENERATE")


class InstallerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="newsroom-install-test-"))
        self.project = self.tmp / "project"
        self.project.mkdir()
        shutil.copy(REPO_ROOT / ".env.example", self.project / ".env.example")
        (self.project / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.bin_dir = self.tmp / "bin"
        self.log = self.tmp / "docker.log"
        self.log.write_text("", encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def base_env(self, **extra):
        env = {
            "HOME": str(self.home),
            "PATH": f"{FAKE_BIN}:/usr/local/bin:/usr/bin:/bin",
            "LANG": "C",
            "LC_ALL": "C",
            "FAKE_DOCKER_LOG": str(self.log),
            "FAKE_GPU": "0",
            "NO_COLOR": "1",
            "NEWSROOM_DISK_MB_OVERRIDE": "20480",
        }
        env.update({key: str(value) for key, value in extra.items()})
        return env

    def run_installer(self, *args, env_extra=None, timeout=60, input_text=None):
        env = self.base_env(**(env_extra or {}))
        result = subprocess.run(
            ["bash", str(INSTALL_SH), *args],
            cwd=str(REPO_ROOT),
            env=env,
            text=True,
            input=input_text,
            capture_output=True,
            timeout=timeout,
        )
        return result

    def install_args(self, *extra):
        return (
            "--yes",
            "--project-dir", str(self.project),
            "--bin-dir", str(self.bin_dir),
            "--no-open",
            *extra,
        )

    def read_log(self):
        return self.log.read_text(encoding="utf-8")

    def env_file_text(self):
        return (self.project / ".env").read_text(encoding="utf-8")

    def env_values(self):
        values = {}
        for line in self.env_file_text().splitlines():
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key] = value
        return values


class HelpAndCheckTests(InstallerTestCase):
    def test_help_lists_the_supported_flags(self):
        result = self.run_installer("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        for flag in (
            "--yes", "--mode", "--profile", "--gpu", "--no-gpu", "--port",
            "--check", "--dry-run", "--uninstall", "--purge", "--force-purge",
            "--no-models", "--no-start", "--version",
        ):
            self.assertIn(flag, result.stdout)

    def test_version_is_printed_without_docker(self):
        result = self.run_installer("--version")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("newsroom installer", result.stdout)

    def test_check_reports_success_with_a_usable_docker(self):
        result = self.run_installer("--check", "--project-dir", str(self.project), env_extra={})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("prerequisites OK", result.stdout)
        self.assertIn("compose file", result.stdout)

    def test_check_uses_a_mode_aware_disk_threshold(self):
        demo = self.run_installer(
            "--check", "--project-dir", str(self.project), "--mode", "demo",
            env_extra={"NEWSROOM_DISK_MB_OVERRIDE": "2500"},
        )
        self.assertEqual(demo.returncode, 0, demo.stdout + demo.stderr)
        self.assertIn("demo mode needs 2048 MB", demo.stdout)

        local = self.run_installer(
            "--check", "--project-dir", str(self.project), "--mode", "local",
            env_extra={"NEWSROOM_DISK_MB_OVERRIDE": "2500"},
        )
        self.assertNotEqual(local.returncode, 0)
        self.assertIn("local mode needs at least 10240 MB", local.stdout + local.stderr)

    def test_check_fails_when_docker_is_missing(self):
        result = self.run_installer(
            "--check",
            "--project-dir", str(self.project),
            env_extra={"PATH": f"{BROKEN_BIN}:{FAKE_BIN}:/usr/local/bin:/usr/bin:/bin"},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("docker is not installed", result.stdout + result.stderr)

    def test_check_can_allow_a_missing_docker_for_ci(self):
        result = self.run_installer(
            "--check",
            "--allow-missing-docker",
            "--project-dir", str(self.project),
            env_extra={"PATH": f"{BROKEN_BIN}:/usr/local/bin:/usr/bin:/bin"},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("prerequisites OK", result.stdout)
        self.assertIn("skipping the Docker-dependent checks", result.stdout + result.stderr)

    def test_check_fails_when_the_daemon_is_down(self):
        result = self.run_installer(
            "--check",
            "--project-dir", str(self.project),
            env_extra={"FAKE_DOCKER_DOWN": "1"},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("daemon is not reachable", result.stdout + result.stderr)


class InstallTests(InstallerTestCase):
    def test_full_install_generates_secrets_and_runs_every_step(self):
        result = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        env_text = self.env_file_text()
        effective = "\n".join(
            line for line in env_text.splitlines() if line and not line.startswith("#")
        )
        self.assertNotRegex(effective, GENERATED_TOKEN)
        values = self.env_values()
        self.assertEqual(values["NEWSROOM_PROFILE"], "cpu")
        self.assertGreaterEqual(len(values["POSTGRES_PASSWORD"]), 32)
        self.assertGreaterEqual(len(values["API_GATEWAY_SHARED_API_KEY"]), 32)
        self.assertIn(values["POSTGRES_PASSWORD"], values["DATABASE_URL"])
        self.assertNotEqual(values["POSTGRES_PASSWORD"], values["API_GATEWAY_SHARED_API_KEY"])
        self.assertEqual(stat.S_IMODE((self.project / ".env").stat().st_mode), 0o600)

        log = self.read_log()
        # The default demo mode is instant and never downloads models.
        for expected in ("--profile cpu", "BUILD", "MIGRATE", "ADMIN_CREATED", "STACK_UP"):
            self.assertIn(expected, log)
        self.assertNotIn("MODEL_INIT", log)
        self.assertIn("demo mode needs no models", result.stdout)
        self.assertIn("ADMIN_STDIN_LEN=", log)
        self.assertNotIn(values["POSTGRES_PASSWORD"], log)

        launcher = self.bin_dir / "newsroom"
        self.assertTrue(launcher.is_file())
        self.assertTrue(os.access(launcher, os.X_OK))
        self.assertIn(str(REPO_ROOT / "bin" / "newsroom.sh"), launcher.read_text(encoding="utf-8"))

        state = (self.project / ".newsroom" / "state.env").read_text(encoding="utf-8")
        self.assertIn("ADMIN_CREATED=1", state)
        self.assertNotIn("MODELS_DOWNLOADED=1", state)
        self.assertIn("MIGRATIONS_APPLIED=1", state)
        self.assertEqual(values["NEWSROOM_MODE"], "demo")
        self.assertEqual(values["COMPOSE_PROFILES"], "")

    def test_panel_proxy_network_uses_a_free_subnet(self):
        result = self.run_installer(
            *self.install_args("--profile", "cpu"),
            env_extra={"FAKE_DOCKER_TAKEN_SUBNETS": "172.28.240.0/24,172.29.240.0/24"},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        values = self.env_values()
        self.assertEqual(values["NEWSROOM_PANEL_SUBNET"], "172.30.240.0/24")
        self.assertEqual(values["NEWSROOM_PANEL_IP"], "172.30.240.10")
        self.assertEqual(values["TRUSTED_PROXY_CIDRS"], "172.30.240.10/32")
        self.assertIn("panel proxy network: 172.30.240.0/24", result.stdout)

    def test_panel_proxy_network_defaults_to_the_first_free_range(self):
        result = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        values = self.env_values()
        self.assertEqual(values["NEWSROOM_PANEL_SUBNET"], "172.28.240.0/24")
        self.assertEqual(values["NEWSROOM_PANEL_IP"], "172.28.240.10")
        self.assertEqual(values["TRUSTED_PROXY_CIDRS"], "172.28.240.10/32")

    def test_panel_proxy_network_is_stable_across_reinstalls(self):
        first = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        first_network = {
            key: self.env_values()[key]
            for key in ("NEWSROOM_PANEL_SUBNET", "NEWSROOM_PANEL_IP", "TRUSTED_PROXY_CIDRS")
        }
        second = self.run_installer(
            *self.install_args("--profile", "cpu"),
            env_extra={"FAKE_DOCKER_TAKEN_SUBNETS": ""},
        )
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        for key, value in first_network.items():
            self.assertEqual(self.env_values()[key], value)

    def test_local_mode_downloads_models_and_activates_the_local_profile(self):
        result = self.run_installer(
            *self.install_args("--mode", "local", "--profile", "cpu"),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        log = self.read_log()
        self.assertIn("MODEL_INIT", log)
        self.assertIn("OLLAMA_PULL", log)
        self.assertTrue(
            any(" up -d --wait ollama" in line for line in log.splitlines()),
            "the installer must wait for Ollama health before pulling",
        )
        self.assertIn("~2 GB", result.stdout)
        self.assertIn("~0.5 GB", result.stdout)
        stack_up = [line for line in log.splitlines() if " up -d --build" in line][-1]
        self.assertIn("--profile local", stack_up)
        values = self.env_values()
        self.assertEqual(values["NEWSROOM_MODE"], "local")
        self.assertEqual(values["COMPOSE_PROFILES"], "local")
        state = (self.project / ".newsroom" / "state.env").read_text(encoding="utf-8")
        self.assertIn("MODELS_DOWNLOADED=1", state)
        self.assertEqual(self.env_values()["TTS_WORKER_ENGINE"], "piper")

    def test_second_install_is_idempotent(self):
        first = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        first_env = self.env_file_text()
        first_log = self.read_log()

        second = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(self.env_file_text(), first_env)
        second_log = self.read_log()[len(first_log):]
        self.assertNotIn("MODEL_INIT", second_log)
        self.assertNotIn("MIGRATE", second_log)
        self.assertNotIn("ADMIN_CREATED", second_log)
        self.assertIn("STACK_UP", second_log)

    def test_existing_env_values_are_preserved(self):
        self.run_installer(*self.install_args("--profile", "cpu"))
        env_path = self.project / ".env"
        original = self.env_file_text()
        custom = original.replace(
            re.search(r"^OLLAMA_MODEL=.*$", original, re.MULTILINE).group(0),
            "OLLAMA_MODEL=custom-model:7b",
        )
        env_path.write_text(custom, encoding="utf-8")

        result = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OLLAMA_MODEL=custom-model:7b", self.env_file_text())
        self.assertEqual(self.env_values()["POSTGRES_PASSWORD"], self.env_values()["POSTGRES_PASSWORD"])

    def test_gpu_profile_is_detected_from_nvidia_smi(self):
        result = self.run_installer(
            *self.install_args("--profile", "auto"),
            env_extra={"FAKE_GPU": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--profile gpu", self.read_log())
        self.assertEqual(self.env_values()["NEWSROOM_PROFILE"], "gpu")

    def test_gpu_profile_applies_the_gpu_compose_overlay(self):
        result = self.run_installer(
            *self.install_args("--gpu"),
            env_extra={"FAKE_GPU": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        log = self.read_log()
        self.assertIn("--profile gpu", log)
        self.assertIn("infra/compose/compose.gpu.yaml", log)
        self.assertGreaterEqual(log.count("infra/compose/compose.gpu.yaml"), 2)
        values = self.env_values()
        self.assertEqual(values["TTS_WORKER_ENGINE"], "qwen")
        self.assertEqual(values["OLLAMA_KEEP_ALIVE"], "0s")

    def test_cpu_profile_never_applies_the_gpu_overlay(self):
        result = self.run_installer(*self.install_args("--no-gpu"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("compose.gpu.yaml", self.read_log())

    def test_gpu_profile_fails_clearly_without_the_overlay(self):
        result = self.run_installer(
            *self.install_args("--gpu"),
            env_extra={
                "FAKE_GPU": "1",
                "NEWSROOM_GPU_COMPOSE_FILE": str(self.tmp / "missing.gpu.yaml"),
            },
        )
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("compose overlay", result.stdout + result.stderr)
        self.assertIn("missing.gpu.yaml", result.stdout + result.stderr)

    def test_auto_profile_falls_back_to_cpu_without_a_gpu(self):
        result = self.run_installer(*self.install_args("--profile", "auto"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--profile cpu", self.read_log())
        self.assertEqual(self.env_values()["NEWSROOM_PROFILE"], "cpu")

    def test_gpu_flag_selects_the_gpu_profile(self):
        result = self.run_installer(*self.install_args("--gpu"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--profile gpu", self.read_log())
        self.assertEqual(self.env_values()["NEWSROOM_PROFILE"], "gpu")

    def test_no_gpu_flag_wins_over_detected_hardware(self):
        result = self.run_installer(
            *self.install_args("--no-gpu"), env_extra={"FAKE_GPU": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--profile cpu", self.read_log())
        self.assertNotIn("--profile gpu", self.read_log())
        self.assertEqual(self.env_values()["NEWSROOM_PROFILE"], "cpu")

    def test_port_flag_sets_the_published_panel_port(self):
        result = self.run_installer(*self.install_args("--port", "18080"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        values = self.env_values()
        self.assertEqual(values["PANEL_PORT"], "18080")
        self.assertIn("http://127.0.0.1:18080", result.stdout)
        for key in ("API_GATEWAY_ALLOWED_ORIGINS", "API_GATEWAY_TRUSTED_MUTATION_ORIGINS"):
            self.assertIn("http://127.0.0.1:18080", values[key], key)
            self.assertNotIn(":8080", values[key], key)

    def test_port_flag_rejects_invalid_values(self):
        for value in ("0", "70000", "eighty"):
            result = self.run_installer(*self.install_args("--port", value))
            self.assertNotEqual(result.returncode, 0, value)
            self.assertIn("invalid --port", result.stdout + result.stderr)

    def test_gpu_and_no_gpu_flags_conflict(self):
        result = self.run_installer(*self.install_args("--gpu", "--no-gpu"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conflicts", result.stdout + result.stderr)

    def test_no_start_skips_the_stack_and_says_so(self):
        result = self.run_installer(*self.install_args("--no-start"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("STACK_UP", self.read_log())
        self.assertIn("(not started)", result.stdout)

    def test_compose_file_override_is_used(self):
        alternate = self.project / "compose-alt.yaml"
        alternate.write_text("services: {}\n", encoding="utf-8")
        result = self.run_installer(*self.install_args("--compose-file", str(alternate)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"-f {alternate}", self.read_log())

    def test_no_models_skips_the_download_and_marks_state(self):
        result = self.run_installer(*self.install_args("--profile", "cpu", "--no-models"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("MODEL_INIT", self.read_log())
        state = (self.project / ".newsroom" / "state.env").read_text(encoding="utf-8")
        self.assertNotIn("MODELS_DOWNLOADED=1", state)

    def test_no_models_skips_the_local_mode_download(self):
        result = self.run_installer(
            *self.install_args("--mode", "local", "--profile", "cpu", "--no-models"),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("skipping model download (--no-models)", result.stdout)
        self.assertNotIn("MODEL_INIT", self.read_log())
        self.assertNotIn("OLLAMA_PULL", self.read_log())
        state = (self.project / ".newsroom" / "state.env").read_text(encoding="utf-8")
        self.assertNotIn("MODELS_DOWNLOADED=1", state)

    def test_summary_box_lists_panel_admin_and_lifecycle_commands(self):
        result = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for line in (
            "Newsroom installation summary",
            "Panel:    http://127.0.0.1:8080 (running)",
            "Admin:    admin@example.local",
            "Start:    newsroom up",
            "Stop:     newsroom down",
            "Logs:     newsroom logs [service]",
            "Health:   newsroom doctor",
        ):
            self.assertIn(line, result.stdout)

    def test_admin_email_option_is_written_to_env_and_used(self):
        result = self.run_installer(
            *self.install_args("--profile", "cpu", "--admin-email", "owner@example.local"),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.env_values()["NEWSROOM_ADMIN_EMAIL"], "owner@example.local")
        self.assertIn("--email owner@example.local", self.read_log())

    def test_generated_admin_password_is_printed_once_and_not_stored(self):
        result = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Generated administrator password", result.stdout)
        match = re.search(r"Generated administrator password.*\n\| ([0-9a-f]{16,}) +\|", result.stdout)
        self.assertIsNotNone(match, result.stdout)
        password = match.group(1)
        for path in self.project.rglob("*"):
            if path.is_file():
                self.assertNotIn(password, path.read_text(encoding="utf-8", errors="ignore"), path)

    def test_missing_compose_file_fails_before_changing_anything(self):
        (self.project / "compose.yaml").unlink()
        result = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("compose file not found", result.stdout + result.stderr)
        self.assertFalse((self.project / ".env").exists())

    def test_dry_run_prints_the_plan_without_writing(self):
        result = self.run_installer(
            "--dry-run", "--yes", "--project-dir", str(self.project),
            "--bin-dir", str(self.bin_dir), "--no-open", "--profile", "cpu", "--port", "18080",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("dry-run: no files", result.stdout)
        self.assertIn("docker compose", result.stdout)
        self.assertIn("open the panel at http://127.0.0.1:18080", result.stdout)
        self.assertIn("Panel:    http://127.0.0.1:18080", result.stdout)
        self.assertFalse((self.project / ".env").exists())
        self.assertFalse((self.bin_dir / "newsroom").exists())
        self.assertFalse((self.project / ".newsroom").exists())


class UninstallTests(InstallerTestCase):
    def test_uninstall_stops_the_stack_and_keeps_data(self):
        self.assertEqual(self.run_installer(*self.install_args("--profile", "cpu")).returncode, 0)
        result = self.run_installer(
            "--uninstall", "--yes", "--project-dir", str(self.project),
            "--bin-dir", str(self.bin_dir),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        log = self.read_log()
        self.assertIn("STACK_DOWN", log)
        self.assertNotIn("VOLUMES_REMOVED", log)
        self.assertTrue((self.project / ".env").exists())
        self.assertFalse((self.bin_dir / "newsroom").exists())

    def test_uninstall_stops_the_local_profile_services_too(self):
        self.assertEqual(
            self.run_installer(*self.install_args("--mode", "local", "--profile", "cpu")).returncode,
            0,
        )
        self.log.write_text("", encoding="utf-8")
        result = self.run_installer(
            "--uninstall", "--yes", "--project-dir", str(self.project),
            "--bin-dir", str(self.bin_dir),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        stack_down = [line for line in self.read_log().splitlines() if " down " in line][-1]
        self.assertIn("--profile local", stack_down)

    def test_purge_removes_volumes_state_and_env_with_force_purge(self):
        self.assertEqual(self.run_installer(*self.install_args("--profile", "cpu")).returncode, 0)
        result = self.run_installer(
            "--uninstall", "--purge", "--yes", "--force-purge",
            "--project-dir", str(self.project),
            "--bin-dir", str(self.bin_dir),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("VOLUMES_REMOVED", self.read_log())
        self.assertFalse((self.project / ".env").exists())
        self.assertFalse((self.project / ".newsroom").exists())

    def test_purge_with_yes_without_force_purge_keeps_data(self):
        self.assertEqual(self.run_installer(*self.install_args("--profile", "cpu")).returncode, 0)
        result = self.run_installer(
            "--uninstall", "--purge", "--yes",
            "--project-dir", str(self.project),
            "--bin-dir", str(self.bin_dir),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("VOLUMES_REMOVED", self.read_log())
        self.assertIn("--force-purge", result.stdout + result.stderr)
        self.assertTrue((self.project / ".env").exists())

    def test_purge_requires_the_literal_delete_confirmation(self):
        self.assertEqual(self.run_installer(*self.install_args("--profile", "cpu")).returncode, 0)
        rejected = self.run_installer(
            "--uninstall", "--purge",
            "--project-dir", str(self.project),
            "--bin-dir", str(self.bin_dir),
            input_text="yes\n",
        )
        self.assertEqual(rejected.returncode, 0, rejected.stdout + rejected.stderr)
        self.assertNotIn("VOLUMES_REMOVED", self.read_log())
        self.assertTrue((self.project / ".env").exists())

        accepted = self.run_installer(
            "--uninstall", "--purge",
            "--project-dir", str(self.project),
            "--bin-dir", str(self.bin_dir),
            input_text="delete\n",
        )
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
        self.assertIn("VOLUMES_REMOVED", self.read_log())
        self.assertFalse((self.project / ".env").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
