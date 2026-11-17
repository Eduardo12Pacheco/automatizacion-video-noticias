"""Checksum-pinned model download contract."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock
import sys
import types

ROOT = Path(__file__).resolve().parents[2]
MODEL_INIT = ROOT / "infra" / "models" / "model-init.py"
MANIFEST = ROOT / "infra" / "models" / "model-manifest.json"


def load_model_init():
    spec = importlib.util.spec_from_file_location("model_init_under_test", MODEL_INIT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FileHandler(BaseHTTPRequestHandler):
    body = b""

    def do_GET(self):  # noqa: N802 - http.server API
        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("content-length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *_args):
        return


class ModelManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    def test_every_file_is_pinned_to_a_revision_and_sha256(self) -> None:
        self.assertRegex(self.manifest["piper"]["revision"], r"^[0-9a-f]{40}$")
        for voice in ("en_US-lessac-medium", "es_ES-davefx-medium"):
            self.assertTrue(self.manifest["piper"]["voices"][voice]["files"])
        for model, entry in self.manifest["whisper"].items():
            self.assertRegex(entry["revision"], r"^[0-9a-f]{40}$", model)
            self.assertTrue(entry["files"], model)
        entries = [*self.manifest["whisper"].values(), self.manifest["qwenTts"]]
        entries.extend(self.manifest["piper"]["voices"].values())
        for entry in entries:
            for file in entry["files"]:
                self.assertRegex(file["sha256"], r"^[0-9a-f]{64}$", file["path"])
                self.assertGreater(file["size"], 0, file["path"])


class ModelDownloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_model_init()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FileHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.tmp = TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def test_downloads_and_verifies_sha256(self) -> None:
        FileHandler.body = b"model-bytes"
        digest = hashlib.sha256(FileHandler.body).hexdigest()
        target = self.root / "model.bin"
        self.module.download(f"{self.base}/model.bin", target, digest, len(FileHandler.body))
        self.assertEqual(target.read_bytes(), b"model-bytes")
        # A second run verifies the present file instead of downloading it.
        self.module.download(f"{self.base}/missing.bin", target, digest, len(FileHandler.body))

    def test_checksum_mismatch_fails_loudly_and_leaves_no_partial_file(self) -> None:
        FileHandler.body = b"tampered"
        target = self.root / "model.bin"
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            self.module.download(f"{self.base}/model.bin", target, "0" * 64, len(FileHandler.body))
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(".bin.part").exists())

    def test_existing_corrupt_file_is_not_trusted(self) -> None:
        FileHandler.body = b"expected"
        target = self.root / "model.bin"
        target.write_bytes(b"corrupt")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            self.module.download(f"{self.base}/model.bin", target, hashlib.sha256(b"expected").hexdigest(), 8)

    def test_urls_include_the_pinned_revision(self) -> None:
        url = self.module.url_for("Org/Model", "a" * 40, "config.json")
        self.assertIn("/resolve/" + "a" * 40 + "/config.json", url)


if __name__ == "__main__":
    unittest.main()


class QwenModelInitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_model_init()
        self.manifest = self.module.load_manifest()
        self.tmp = TemporaryDirectory(prefix="newsroom-model-init-")
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_with_env(self, **values):
        import contextlib
        import io
        import os

        env = {
            "TTS_WORKER_ENGINE": values.pop("engine", "piper"),
            "QWEN_TTS_MODEL_DIR": str(self.root / "qwen"),
            **values,
        }
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=False), contextlib.redirect_stdout(out):
            self.module.init_qwen_tts(self.manifest)
        return out.getvalue()

    def test_cpu_installs_do_not_download_the_qwen_checkpoint(self):
        calls = []
        with mock.patch.dict(sys.modules, {"huggingface_hub": types.SimpleNamespace(snapshot_download=lambda **kw: calls.append(kw))}):
            output = self.run_with_env(engine="piper")
        self.assertIn("Qwen TTS not selected", output)
        self.assertEqual(calls, [])

    def test_present_checkpoint_is_reused(self):
        with mock.patch.object(self.module, "verify_file", return_value=True), \
                mock.patch.dict(sys.modules, {"huggingface_hub": types.SimpleNamespace(snapshot_download=self.fail)}):
            output = self.run_with_env(engine="qwen")
        self.assertIn("verified", output)

    def test_gpu_install_downloads_the_pinned_revision_into_the_volume(self):
        calls = []

        def snapshot_download(**kwargs):
            calls.append(kwargs)

        verified_once = {"first": True}

        def verify_missing_first(*_args, **_kwargs):
            if verified_once["first"]:
                verified_once["first"] = False
                return False
            return True

        with mock.patch.object(self.module, "verify_file", side_effect=verify_missing_first), \
                mock.patch.dict(sys.modules, {"huggingface_hub": types.SimpleNamespace(snapshot_download=snapshot_download)}):
            output = self.run_with_env(engine="qwen")
        self.assertIn("~4.5 GB", output)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["repo_id"], "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
        self.assertEqual(calls[0]["local_dir"], str(self.root / "qwen"))
        self.assertRegex(calls[0]["revision"], r"^[0-9a-f]{40}$")

    def fail(self, **_kwargs):
        raise AssertionError("snapshot_download must not be called")
