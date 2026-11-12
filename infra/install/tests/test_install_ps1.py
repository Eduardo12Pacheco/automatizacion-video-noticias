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
    def run_ps(self, *args, env_extra=None, timeout=120):
        env = self.base_env(**(env_extra or {}))
        return subprocess.run(
            powershell_command() + ["-File", str(INSTALL_PS1), *args],
            cwd=str(REPO_ROOT),
            env=env,
            text=True,
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
        for expected in ("--profile cpu", "BUILD", "MODEL_INIT", "MIGRATE", "ADMIN_CREATED", "STACK_UP"):
            self.assertIn(expected, log)
        self.assertNotIn(values["POSTGRES_PASSWORD"], log)
        self.assertTrue((self.bin_dir / "newsroom.ps1").is_file())
        self.assertTrue((self.bin_dir / "newsroom.cmd").is_file())
        self.assertIn("Generated administrator password", result.stdout)

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
            "-Uninstall", "-Purge", "-Yes",
            "-ProjectDir", str(self.project), "-BinDir", str(self.bin_dir),
        )
        self.assertEqual(purge.returncode, 0, purge.stdout + purge.stderr)
        self.assertIn("VOLUMES_REMOVED", self.read_log())
        self.assertFalse((self.project / ".env").exists())

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
        self.assertIn("Models: downloaded", doctor.stdout)
        self.assertIn("Admin:  initialized", doctor.stdout)

    def test_cli_help_and_unknown_command(self):
        help_result = self.run_cli("help")
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        for command in ("up", "down", "status", "logs", "update", "doctor", "models"):
            self.assertIn(command, help_result.stdout)
        unknown = self.run_cli("--project-dir", str(self.project), "explode")
        self.assertNotEqual(unknown.returncode, 0)
        self.assertIn("unknown command", unknown.stdout + unknown.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
