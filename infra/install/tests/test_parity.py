#!/usr/bin/env python3
"""Static parity checks between the Linux and Windows entrypoints.

Both installers must expose the same behaviour. Full end-to-end parity is
covered by the behaviour suites; this guard catches accidental drift in flag
names or in the compose contract they call.
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
INSTALL_SH = (REPO_ROOT / "install.sh").read_text(encoding="utf-8") + "\n" + "\n".join(
    path.read_text(encoding="utf-8") for path in sorted((REPO_ROOT / "infra/install/lib").glob("*.sh"))
)
INSTALL_PS1 = (REPO_ROOT / "install.ps1").read_text(encoding="utf-8") + "\n" + "\n".join(
    path.read_text(encoding="utf-8") for path in sorted((REPO_ROOT / "infra/install/lib").glob("*.psm1"))
)
CLI_SH = (REPO_ROOT / "bin" / "newsroom.sh").read_text(encoding="utf-8")
CLI_PS1 = (REPO_ROOT / "bin" / "newsroom.ps1").read_text(encoding="utf-8")


def bash_long_flags(text):
    return set(re.findall(r"--[a-z][a-z-]+", text))


def powershell_switches(text):
    names = set()
    for match in re.finditer(r"\[(?:switch|string|ValidateSet\([^)]*\)\]\[string\])\]\s*\$(\w+)", text):
        names.add(match.group(1).lower())
    return names


class InstallerParityTests(unittest.TestCase):
    def test_every_linux_flag_has_a_windows_switch(self):
        bash_flags = {
            "yes": "yes",
            "dry-run": "dryrun",
            "uninstall": "uninstall",
            "purge": "purge",
            "no-models": "nomodels",
            "no-start": "nostart",
            "no-open": "noopen",
            "check": "check",
            "profile": "profile",
            "bin-dir": "bindir",
            "admin-email": "adminemail",
            "project-dir": "projectdir",
            "compose-file": "composefile",
            "allow-missing-docker": "allowmissingdocker",
        }
        switches = powershell_switches(INSTALL_PS1)
        for flag, switch in bash_flags.items():
            self.assertIn("--" + flag, INSTALL_SH, flag)
            self.assertIn(switch, switches, flag)

    def test_both_installers_share_the_compose_contract(self):
        for snippet in ("model-init", "migrate", "scripts/create-admin.js", "--password-stdin"):
            self.assertIn(snippet, INSTALL_SH, snippet)
            self.assertIn(snippet, INSTALL_PS1, snippet)

    def test_both_clis_expose_the_same_commands(self):
        for command in ("up", "down", "status", "logs", "update", "doctor", "models", "version"):
            self.assertIn(command, CLI_SH, command)
            self.assertIn(command, CLI_PS1, command)

    def test_environment_template_covers_the_adapter_defaults(self):
        template = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
        for key in (
            "DATABASE_URL", "LLM=ollama", "ARTICLE_EXTRACTOR=trafilatura",
            "IMAGE_SEARCH=searxng", "NOTIFY=console", "WORKFLOW=disabled",
            "TTS_WORKER_ENGINE=auto", "NEWSROOM_GPU_LOCK_PATH",
        ):
            self.assertIn(key, template, key)


if __name__ == "__main__":
    unittest.main(verbosity=2)
