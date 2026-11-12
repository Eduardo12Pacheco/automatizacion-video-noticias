#!/usr/bin/env python3
"""Behaviour tests for install.ps1 and bin/newsroom.ps1.

PowerShell 5.1 is the Windows target; these tests execute the same scripts with
pwsh on Linux (the fake docker records compose calls). They are skipped when no
PowerShell binary is available or on native Windows, where the "UnixFileMode"
assertions do not apply and the fake shims cannot run.
"""
import os
import re
import shutil
import stat
import subprocess
import sys
import unittest

from test_install_sh import BROKEN_BIN, FAKE_BIN, REPO_ROOT, InstallerTestCase

PWSH = os.environ.get("PWSH_BIN") or shutil.which("pwsh") or shutil.which("powershell")
INSTALL_PS1 = REPO_ROOT / "install.ps1"
CLI_PS1 = REPO_ROOT / "bin" / "newsroom.ps1"


def powershell_command():
    return [PWSH, "-NoProfile"]


@unittest.skipIf(os.name == "nt", "Linux smoke tests; Windows CI runs install.ps1 -Check")
@unittest.skipIf(PWSH is None, "pwsh/powershell is not installed")
class PowerShellInstallerTests(InstallerTestCase):
    def run_ps(self, *args, env_extra=None, timeout=120, input_text=None):
        env = self.base_env(**(env_extra or {}))
        return subprocess.run(
            powershell_command() + ["-File", str(INSTALL_PS1), *args],
            cwd=str(REPO_ROOT),
            env=env,
            text=True,
            input=input_text,
            capture_output=True,
            timeout=timeout,
        )

    def run_cli(self, *args, env_extra=None, timeout=120):
        env = self.base_env(**(env_extra or {}))
        return subprocess.run(
            powershell_command() + ["-File", str(CLI_PS1), *args],
            cwd=str(REPO_ROOT),
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout,
        )

    def ps_args(self, *extra):
        return (
            "-Yes", "-Profile", "cpu",
            "-ProjectDir", str(self.project),
            "-BinDir", str(self.bin_dir),
            "-NoOpen",
            *extra,
        )

    def set_env(self, key, value):
        path = self.project / ".env"
        lines = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(key + "="):
                lines.append(f"{key}={value}")
            else:
                lines.append(line)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_version_is_printed_without_docker(self):
        result = self.run_ps("-Version")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("newsroom installer", result.stdout)

    def test_check_reports_prerequisites(self):
        result = self.run_ps("-Check", "-ProjectDir", str(self.project))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("prerequisites OK", result.stdout)

    def test_check_allows_a_missing_docker_for_ci(self):
        result = self.run_ps(
            "-Check", "-AllowMissingDocker", "-Yes",
            "-ProjectDir", str(self.project),
            env_extra={"PATH": f"{BROKEN_BIN}:/usr/local/bin:/usr/bin:/bin"},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("prerequisites OK", result.stdout)
        self.assertIn("skipping the Docker-dependent checks", result.stdout + result.stderr)

    def test_full_install_generates_secrets_and_runs_every_step(self):
        result = self.run_ps(*self.ps_args())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        env_text = self.env_file_text()
        effective = "\n".join(line for line in env_text.splitlines() if line and not line.startswith("#"))
        self.assertNotRegex(effective, re.compile("__GENERATE"))
        values = self.env_values()
        self.assertGreaterEqual(len(values["POSTGRES_PASSWORD"]), 32)
        self.assertIn(values["POSTGRES_PASSWORD"], values["DATABASE_URL"])
        self.assertEqual(stat.S_IMODE((self.project / ".env").stat().st_mode), 0o600)
        self.assertFalse((self.project / ".env").read_bytes().startswith(b"\xef\xbb\xbf"))

        log = self.read_log()
        for expected in ("--profile cpu", "BUILD", "MIGRATE", "ADMIN_CREATED", "STACK_UP"):
            self.assertIn(expected, log)
        self.assertNotIn("MODEL_INIT", log)
        self.assertNotIn(values["POSTGRES_PASSWORD"], log)
        self.assertTrue((self.bin_dir / "newsroom.ps1").is_file())
        self.assertTrue((self.bin_dir / "newsroom.cmd").is_file())
        self.assertIn("Generated administrator password", result.stdout)

    def test_local_mode_activates_the_local_profile(self):
        result = self.run_ps(*self.ps_args("-Mode", "local"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        log = self.read_log()
        self.assertIn("MODEL_INIT", log)
        stack_up = [line for line in log.splitlines() if " up -d --build" in line][-1]
        self.assertIn("--profile local", stack_up)
        self.assertEqual(self.env_values()["TTS_WORKER_ENGINE"], "piper")

    def test_second_install_is_idempotent(self):
        first = self.run_ps(*self.ps_args())
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        first_env = self.env_file_text()
        first_log_length = len(self.read_log())
        second = self.run_ps(*self.ps_args())
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(self.env_file_text(), first_env)
        second_log = self.read_log()[first_log_length:]
        self.assertNotIn("MODEL_INIT", second_log)
        self.assertNotIn("MIGRATE", second_log)
        self.assertNotIn("ADMIN_CREATED", second_log)
        self.assertIn("STACK_UP", second_log)

    def test_gpu_profile_is_detected(self):
        result = self.run_ps(
            "-Yes", "-ProjectDir", str(self.project), "-BinDir", str(self.bin_dir),
            "-NoOpen", "-Profile", "auto",
            env_extra={"FAKE_GPU": "1"},
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("--profile gpu", self.read_log())

    def test_gpu_and_no_gpu_switches(self):
        gpu = self.run_ps(
            "-Yes", "-ProjectDir", str(self.project), "-BinDir", str(self.bin_dir),
            "-NoOpen", "-Gpu",
        )
        self.assertEqual(gpu.returncode, 0, gpu.stdout + gpu.stderr)
        self.assertIn("--profile gpu", self.read_log())
        self.assertEqual(self.env_values()["NEWSROOM_PROFILE"], "gpu")

        self.log.write_text("", encoding="utf-8")
        cpu = self.run_ps(
            "-Yes", "-ProjectDir", str(self.project), "-BinDir", str(self.bin_dir),
            "-NoOpen", "-NoGpu",
            env_extra={"FAKE_GPU": "1"},
        )
        self.assertEqual(cpu.returncode, 0, cpu.stdout + cpu.stderr)
        self.assertIn("--profile cpu", self.read_log())
        self.assertNotIn("--profile gpu", self.read_log())
        self.assertEqual(self.env_values()["NEWSROOM_PROFILE"], "cpu")

    def test_port_sets_the_published_panel_port(self):
        result = self.run_ps(*self.ps_args("-Port", "18080"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        values = self.env_values()
        self.assertEqual(values["PANEL_PORT"], "18080")
        self.assertIn("http://127.0.0.1:18080", result.stdout)
        for key in ("API_GATEWAY_ALLOWED_ORIGINS", "API_GATEWAY_TRUSTED_MUTATION_ORIGINS"):
            self.assertIn("http://127.0.0.1:18080", values[key], key)
            self.assertNotIn(":8080", values[key], key)

    def test_port_rejects_invalid_values(self):
        for value in ("0", "70000", "eighty"):
            result = self.run_ps(*self.ps_args("-Port", value))
            self.assertNotEqual(result.returncode, 0, value)
            self.assertIn("invalid -Port", result.stdout + result.stderr)

    def test_no_start_skips_the_stack_and_says_so(self):
        result = self.run_ps(*self.ps_args("-NoStart"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("STACK_UP", self.read_log())
        self.assertIn("(not started)", result.stdout)

    def test_compose_file_override_is_used(self):
        alternate = self.project / "compose-alt.yaml"
        alternate.write_text("services: {}\n", encoding="utf-8")
        result = self.run_ps(*self.ps_args("-ComposeFile", str(alternate)))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(str(alternate), self.read_log())

    def test_no_models_skips_the_local_download(self):
        result = self.run_ps(*self.ps_args("-Mode", "local", "-NoModels"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("skipping model download (-NoModels)", result.stdout)
        self.assertNotIn("MODEL_INIT", self.read_log())
        state = (self.project / ".newsroom" / "state.env").read_text(encoding="utf-8")
        self.assertNotIn("MODELS_DOWNLOADED=1", state)

    def test_dry_run_writes_nothing(self):
        result = self.run_ps(
            "-DryRun", "-Yes", "-Profile", "cpu",
            "-ProjectDir", str(self.project), "-BinDir", str(self.bin_dir), "-NoOpen",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("dry-run: no files", result.stdout)
        self.assertFalse((self.project / ".env").exists())
        self.assertFalse((self.bin_dir / "newsroom.ps1").exists())
        self.assertFalse((self.project / ".newsroom").exists())

    def test_missing_compose_file_fails(self):
        (self.project / "compose.yaml").unlink()
        result = self.run_ps(*self.ps_args())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("compose file not found", result.stdout + result.stderr)

    def test_uninstall_and_purge(self):
        self.assertEqual(self.run_ps(*self.ps_args()).returncode, 0)
        result = self.run_ps(
            "-Uninstall", "-Yes", "-ProjectDir", str(self.project), "-BinDir", str(self.bin_dir),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("STACK_DOWN", self.read_log())
        self.assertTrue((self.project / ".env").exists())

        purge = self.run_ps(
            "-Uninstall", "-Purge", "-Yes", "-ForcePurge",
            "-ProjectDir", str(self.project), "-BinDir", str(self.bin_dir),
        )
        self.assertEqual(purge.returncode, 0, purge.stdout + purge.stderr)
        self.assertIn("VOLUMES_REMOVED", self.read_log())
        self.assertFalse((self.project / ".env").exists())

    def test_purge_with_yes_without_force_purge_keeps_data(self):
        self.assertEqual(self.run_ps(*self.ps_args()).returncode, 0)
        result = self.run_ps(
            "-Uninstall", "-Purge", "-Yes",
            "-ProjectDir", str(self.project), "-BinDir", str(self.bin_dir),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("VOLUMES_REMOVED", self.read_log())
        self.assertIn("-ForcePurge", result.stdout + result.stderr)
        self.assertTrue((self.project / ".env").exists())

    def test_cli_status_and_doctor(self):
        self.assertEqual(self.run_ps(*self.ps_args()).returncode, 0)
        self.log.write_text("", encoding="utf-8")
        status = self.run_cli("--project-dir", str(self.project), "status")
        self.assertEqual(status.returncode, 0, status.stdout + status.stderr)
        self.assertIn(" ps", self.read_log())
        self.log.write_text("", encoding="utf-8")
        doctor = self.run_cli("--project-dir", str(self.project), "doctor")
        self.assertEqual(doctor.returncode, 0, doctor.stdout + doctor.stderr)
        self.assertIn("prerequisites OK", doctor.stdout)
        self.assertIn("Models: not required (demo mode)", doctor.stdout)
        self.assertIn("Admin:  initialized", doctor.stdout)

    def test_cli_help_and_unknown_command(self):
        help_result = self.run_cli("help")
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        for command in (
            "up", "down", "status", "logs", "update", "mode", "doctor",
            "models", "test",
        ):
            self.assertIn(command, help_result.stdout)
        unknown = self.run_cli("--project-dir", str(self.project), "explode")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown command", unknown.stdout + unknown.stderr)

    def test_cli_models_pull_and_mode(self):
        self.assertEqual(self.run_ps(*self.ps_args()).returncode, 0)
        self.set_env("NEWSROOM_MODE", "local")
        self.log.write_text("", encoding="utf-8")
        pull = self.run_cli("--project-dir", str(self.project), "models", "pull")
        self.assertEqual(pull.returncode, 0, pull.stdout + pull.stderr)
        self.assertIn("MODEL_INIT", self.read_log())

        self.log.write_text("", encoding="utf-8")
        mode = self.run_cli("--project-dir", str(self.project), "mode", "demo")
        self.assertEqual(mode.returncode, 0, mode.stdout + mode.stderr)
        values = self.env_values()
        self.assertEqual(values["NEWSROOM_MODE"], "demo")
        self.assertEqual(values["COMPOSE_PROFILES"], "")
        self.assertIn("run mode set to demo", mode.stdout)

    def test_cli_test_runs_the_ci_runner(self):
        self.assertEqual(self.run_ps(*self.ps_args()).returncode, 0)
        self.log.write_text("", encoding="utf-8")
        result = self.run_cli("--project-dir", str(self.project), "test")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("tools/run-all-tests.mjs", self.read_log())
        self.assertIn("test suite passed", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
