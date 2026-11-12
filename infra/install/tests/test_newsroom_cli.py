#!/usr/bin/env python3
"""Behaviour tests for bin/newsroom.sh, the installed control CLI."""
import subprocess
import unittest

from test_install_sh import FAKE_BIN, REPO_ROOT, InstallerTestCase

CLI = REPO_ROOT / "bin" / "newsroom.sh"


class NewsroomCliTests(InstallerTestCase):
    def run_cli(self, *args, env_extra=None):
        env = self.base_env(**(env_extra or {}))
        return subprocess.run(
            ["bash", str(CLI), *args],
            cwd=str(REPO_ROOT),
            env=env,
            text=True,
            capture_output=True,
            timeout=60,
        )

    def installed(self):
        result = self.run_installer(*self.install_args("--profile", "cpu"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.log.write_text("", encoding="utf-8")

    def project_args(self, *args):
        return ("--project-dir", str(self.project), *args)

    def set_env(self, key, value):
        path = self.project / ".env"
        lines = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(key + "="):
                lines.append(f"{key}={value}")
            else:
                lines.append(line)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_help_lists_every_command(self):
        result = self.run_cli("help")
        self.assertEqual(result.returncode, 0, result.stderr)
        for command in (
            "up", "down", "status", "logs", "update", "mode", "doctor",
            "models", "test", "version",
        ):
            self.assertIn(command, result.stdout)

    def test_version_is_printed_without_docker(self):
        result = self.run_cli("version")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("newsroom", result.stdout)

    def test_status_uses_the_installed_profile(self):
        self.installed()
        result = self.run_cli(*self.project_args("status"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        log = self.read_log()
        self.assertIn("--profile cpu", log)
        self.assertIn(" ps", log)

    def test_up_and_down_wrap_docker_compose(self):
        self.installed()
        up = self.run_cli(*self.project_args("up"))
        self.assertEqual(up.returncode, 0, up.stdout + up.stderr)
        self.assertIn("STACK_UP", self.read_log())

        down = self.run_cli(*self.project_args("down"))
        self.assertEqual(down.returncode, 0, down.stdout + down.stderr)
        self.assertIn("STACK_DOWN", self.read_log())

    def test_logs_accepts_a_service_and_no_follow(self):
        self.installed()
        result = self.run_cli(*self.project_args("logs", "api", "--no-follow"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        log = self.read_log()
        self.assertIn("logs --tail=200 api", log)
        self.assertFalse((self.project / "compose.yaml").read_text() == "")

    def test_profile_override_is_forwarded(self):
        self.installed()
        result = self.run_cli(*self.project_args("--profile", "gpu", "status"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--profile gpu", self.read_log())

    def test_doctor_reports_prerequisites_and_state(self):
        self.installed()
        result = self.run_cli(*self.project_args("doctor"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("prerequisites OK", result.stdout)
        self.assertIn("Installation state", result.stdout)
        self.assertIn("Models: not required (demo mode)", result.stdout)
        self.assertIn("Admin:  initialized", result.stdout)

    def test_doctor_uses_the_installed_mode_disk_threshold(self):
        self.installed()
        self.set_env("NEWSROOM_MODE", "local")
        result = self.run_cli(*self.project_args("doctor"), env_extra={"NEWSROOM_DISK_MB_OVERRIDE": "3000"})
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("local mode needs at least 10240 MB", result.stdout + result.stderr)

    def test_doctor_does_not_flag_ports_published_by_its_own_stack(self):
        self.installed()
        result = self.run_cli(
            *self.project_args("doctor"),
            env_extra={"NEWSROOM_LISTENING_PORTS_OVERRIDE": "8080", "FAKE_DOCKER_PORTS": "8080"},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("port 8080 is published by this Compose stack", result.stdout)
        self.assertNotIn("port 8080 is already in use", result.stdout)

    def test_doctor_warns_about_a_port_held_by_another_process(self):
        self.installed()
        result = self.run_cli(
            *self.project_args("doctor"),
            env_extra={"NEWSROOM_LISTENING_PORTS_OVERRIDE": "8080", "FAKE_DOCKER_PORTS": ""},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("port 8080 is already in use", result.stdout + result.stderr)

    def test_doctor_without_an_install_still_checks_the_host(self):
        result = self.run_cli(*self.project_args("doctor"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("prerequisites OK", result.stdout)
        self.assertIn("not installed yet", result.stdout)

    def test_up_without_env_fails_with_a_clear_message(self):
        result = self.run_cli(*self.project_args("up"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("run install.sh", result.stdout + result.stderr)

    def test_unknown_command_is_rejected(self):
        result = self.run_cli(*self.project_args("explode"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown command", result.stdout + result.stderr)

    def test_models_command_downloads_only_when_missing(self):
        self.installed()
        self.log.write_text("", encoding="utf-8")
        result = self.run_cli(*self.project_args("models"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("MODEL_INIT", self.read_log())

    def test_models_pull_forces_the_download(self):
        self.installed()
        self.set_env("NEWSROOM_MODE", "local")
        self.log.write_text("", encoding="utf-8")
        result = self.run_cli(*self.project_args("models", "pull"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("MODEL_INIT", self.read_log())
        self.assertIn("OLLAMA_PULL", self.read_log())
        state = (self.project / ".newsroom" / "state.env").read_text(encoding="utf-8")
        self.assertIn("MODELS_DOWNLOADED=1", state)

    def test_mode_switches_between_demo_and_local(self):
        self.installed()
        self.log.write_text("", encoding="utf-8")
        local = self.run_cli(*self.project_args("mode", "local"))
        self.assertEqual(local.returncode, 0, local.stdout + local.stderr)
        values = self.env_values()
        self.assertEqual(values["NEWSROOM_MODE"], "local")
        self.assertEqual(values["COMPOSE_PROFILES"], "local")
        log = self.read_log()
        self.assertIn("MODEL_INIT", log)
        self.assertIn("STACK_DOWN", log)
        self.assertIn("STACK_UP", log)
        stack_up = [line for line in log.splitlines() if " up -d --build" in line][-1]
        self.assertIn("--profile local", stack_up)

        demo = self.run_cli(*self.project_args("mode", "demo"))
        self.assertEqual(demo.returncode, 0, demo.stdout + demo.stderr)
        values = self.env_values()
        self.assertEqual(values["NEWSROOM_MODE"], "demo")
        self.assertEqual(values["COMPOSE_PROFILES"], "")
        self.assertIn("run mode set to demo", demo.stdout)

    def test_mode_rejects_an_unknown_value(self):
        self.installed()
        result = self.run_cli(*self.project_args("mode", "production"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("usage: newsroom mode", result.stdout + result.stderr)

    def test_test_command_runs_the_ci_runner(self):
        self.installed()
        self.log.write_text("", encoding="utf-8")
        result = self.run_cli(*self.project_args("test"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("tools/run-all-tests.mjs", self.read_log())
        self.assertIn("test suite passed", result.stdout)

    def test_dry_run_prints_without_calling_docker(self):
        self.installed()
        result = self.run_cli(*self.project_args("--dry-run", "up"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("docker compose", result.stdout)
        self.assertNotIn("STACK_UP", self.read_log())



class UpdateTests(InstallerTestCase):
    def make_repo_copy(self):
        root = self.tmp / "checkout"
        (root / "bin").mkdir(parents=True)
        (root / "infra" / "install" / "lib").mkdir(parents=True)
        (root / "bin" / "newsroom.sh").write_text(CLI.read_text(encoding="utf-8"), encoding="utf-8")
        for name in ("common.sh", "env.sh", "host.sh", "steps.sh"):
            source = REPO_ROOT / "infra" / "install" / "lib" / name
            (root / "infra" / "install" / "lib" / name).write_text(
                source.read_text(encoding="utf-8"), encoding="utf-8",
            )
        (root / ".env").write_text("NEWSROOM_PROFILE=cpu\n", encoding="utf-8")
        (root / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=str(root), check=True)
        subprocess.run(["git", "add", "-A"], cwd=str(root), check=True)
        env = self.base_env()
        env.update({
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.local",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.local",
        })
        subprocess.run(["git", "commit", "-qm", "initial"], cwd=str(root), check=True, env=env)
        return root

    def run_update(self, root, *args):
        env = self.base_env()
        return subprocess.run(
            ["bash", str(root / "bin" / "newsroom.sh"), "--project-dir", str(root), *args],
            cwd=str(root),
            env=env,
            text=True,
            capture_output=True,
            timeout=60,
        )

    def test_update_rebuilds_and_migrates_when_the_checkout_is_clean(self):
        root = self.make_repo_copy()
        result = self.run_update(root, "update")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        log = self.read_log()
        self.assertIn("MIGRATE", log)
        self.assertIn("BUILD", log)
        self.assertIn("STACK_UP", log)
        self.assertIn("no git remote", result.stdout + result.stderr)

    def test_update_refuses_to_run_with_uncommitted_changes(self):
        root = self.make_repo_copy()
        (root / "local.txt").write_text("mine\n", encoding="utf-8")
        result = self.run_update(root, "update")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("uncommitted changes", result.stdout + result.stderr)
        self.assertNotIn("BUILD", self.read_log())


if __name__ == "__main__":
    unittest.main(verbosity=2)
