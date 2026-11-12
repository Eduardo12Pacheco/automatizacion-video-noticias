"""Architecture gates for the T14 ports, contracts and runtime services."""

from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEEP_RELATIVE_IMPORT = re.compile(r"""(?:require\(|from\s+)["'](?:\.\./){4,}""")


def tracked_files(suffixes: tuple[str, ...]) -> list[Path]:
    output = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z"],
        capture_output=True,
        check=True,
    ).stdout
    paths = []
    for raw in output.split(b"\x00"):
        if not raw:
            continue
        relative = raw.decode("utf-8")
        if relative.startswith(("odd/", "examples/", "infra/n8n/")) or "/node_modules/" in relative:
            continue
        if relative.endswith(suffixes):
            paths.append(ROOT / relative)
    return paths


class PortsAndAdaptersTest(unittest.TestCase):
    def test_core_declares_every_required_port(self) -> None:
        source = (ROOT / "packages/core/src/ports/ports.js").read_text(encoding="utf-8")
        index = (ROOT / "packages/core/src/index.js").read_text(encoding="utf-8")
        for name in ("TTSPort", "ASRPort", "TranslationPort", "VideoRendererPort", "AuthPort"):
            self.assertIn(f"export class {name}", source)
            self.assertIn(name, index)

    def test_worker_adapters_have_http_and_demo_implementations(self) -> None:
        worker_sources = (ROOT / "packages/adapters/src/worker-ports.js").read_text(encoding="utf-8")
        auth_source = (ROOT / "packages/adapters/src/auth-port.js").read_text(encoding="utf-8")
        demo_source = (ROOT / "packages/adapters/src/demo.js").read_text(encoding="utf-8")
        for name in ("HttpTTSAdapter", "HttpASRAdapter", "HttpTranslationAdapter", "HttpVideoRendererAdapter"):
            self.assertIn(f"export class {name}", worker_sources)
        for name in ("LocalAuthAdapter", "HttpAuthAdapter"):
            self.assertIn(f"export class {name}", auth_source)
        for name in ("DemoTTSAdapter", "DemoASRAdapter", "DemoTranslationAdapter", "DemoVideoRendererAdapter", "DemoAuthAdapter"):
            self.assertIn(f"export class {name}", demo_source)

    def test_no_cross_package_relative_imports_remain(self) -> None:
        violations = []
        for path in tracked_files((".js", ".mjs", ".cjs")):
            source = path.read_text(encoding="utf-8", errors="ignore")
            if DEEP_RELATIVE_IMPORT.search(source):
                violations.append(str(path.relative_to(ROOT)))
        self.assertEqual(violations, [])

    def test_contracts_package_ships_its_own_green_suite(self) -> None:
        package = json.loads((ROOT / "packages/contracts/package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["scripts"]["test"], "node --test test/*.test.js")
        tests = list((ROOT / "packages/contracts/test").glob("*.test.js"))
        self.assertTrue(tests)
        source = "\n".join(path.read_text(encoding="utf-8") for path in tests)
        for topic in ("parseGuionSegments", "computeApprovalSnapshotHash", "buildApprovalContractPipeline"):
            self.assertIn(topic, source)


class RuntimeServiceTest(unittest.TestCase):
    def test_approval_editor_is_a_compose_service(self) -> None:
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("  approval-editor:\n", compose)
        self.assertIn("API_GATEWAY_APPROVAL_TARGET: http://approval-editor:3042", compose)
        self.assertIn("dockerfile: apps/panel/services/approval-editor/Dockerfile", compose)
        self.assertTrue((ROOT / "apps/panel/services/approval-editor/Dockerfile").is_file())

    def test_script_draft_save_is_a_core_use_case(self) -> None:
        use_case = (ROOT / "packages/core/src/use-cases/save-script-draft.js").read_text(encoding="utf-8")
        router = (ROOT / "apps/api/src/local-router.js").read_text(encoding="utf-8")
        runtime = (ROOT / "apps/api/src/core-runtime.js").read_text(encoding="utf-8")
        self.assertIn("export class SaveScriptDraft", use_case)
        self.assertIn("useCases.saveScriptDraft", router)
        self.assertIn("new SaveScriptDraft({ repository })", runtime)

    def test_classifier_never_drops_unclassified_rows(self) -> None:
        source = (ROOT / "packages/core/src/use-cases/discover-news.js").read_text(encoding="utf-8")
        self.assertIn("needs_review", source)
        self.assertIn("classifier_failed", source)
        self.assertIn("fallbackLlms", source)


if __name__ == "__main__":
    unittest.main()
