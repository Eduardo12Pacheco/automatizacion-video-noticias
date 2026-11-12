"""Content policy gate: no real people, clubs, teams or brands in the tree."""

from __future__ import annotations

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DENYLIST = ROOT / "tools" / "content-denylist.txt"


def load_denylist(path: Path = DENYLIST) -> list[str]:
    terms = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        terms.append(line)
    return terms


def compile_terms(terms: list[str]) -> list[tuple[str, re.Pattern[str]]]:
    patterns = []
    for term in terms:
        escaped = re.escape(term).replace(r"\ ", r"\s+")
        patterns.append((term, re.compile(rf"(?<!\w){escaped}(?!\w)", re.IGNORECASE)))
    return patterns


def tracked_text_files(root: Path = ROOT) -> list[Path]:
    output = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        capture_output=True,
        check=True,
    ).stdout
    files = []
    for raw in output.split(b"\x00"):
        if not raw:
            continue
        relative = raw.decode("utf-8")
        if relative.startswith("odd/"):
            continue
        path = root / relative
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if b"\x00" in data[:8192]:
            continue
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        files.append(path)
    return files


def scan_text(text: str, patterns: list[tuple[str, re.Pattern[str]]]) -> list[tuple[int, str]]:
    findings = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for term, pattern in patterns:
            if pattern.search(line):
                findings.append((line_number, term))
    return findings


def scan_root(root: Path = ROOT) -> list[str]:
    patterns = compile_terms(load_denylist())
    violations = []
    for path in tracked_text_files(root):
        text = path.read_text(encoding="utf-8")
        for line_number, term in scan_text(text, patterns):
            relative = path.relative_to(root)
            violations.append(f"{relative}:{line_number}: {term}")
    return violations


class ContentPolicyTests(unittest.TestCase):
    def test_denylist_is_populated_with_the_task_terms(self):
        terms = {term.lower() for term in load_denylist()}
        for required in ("caicedo", "messi", "chelsea", "barcelona", "real madrid", "mundial", "golazo"):
            self.assertIn(required, terms)

    def test_scanner_detects_a_denied_term_inside_a_text_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "fixture.txt").write_text("El Chelsea ganó el domingo.\n", encoding="utf-8")
            patterns = compile_terms(load_denylist())
            findings = scan_text((root / "fixture.txt").read_text(encoding="utf-8"), patterns)
            self.assertEqual(findings, [(1, "Chelsea")])

    def test_no_tracked_text_file_contains_a_denied_term(self):
        violations = scan_root()
        self.assertEqual(
            violations,
            [],
            "content policy violations:\n" + "\n".join(violations),
        )


if __name__ == "__main__":
    unittest.main()
