"""Behaviour tests for the one-shot model downloader used by the installers."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
MODEL_INIT = ROOT / "infra" / "models" / "model-init.py"


def load_model_init():
    spec = importlib.util.spec_from_file_location("newsroom_model_init", MODEL_INIT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class QwenModelInitTests(unittest.TestCase):
    def setUp(self):
        self.module = load_model_init()
        self.tmp = tempfile.TemporaryDirectory(prefix="newsroom-model-init-")
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_with_env(self, **values):
        env = {
            "TTS_WORKER_ENGINE": values.pop("engine", "piper"),
            "QWEN_TTS_MODEL_DIR": str(self.root / "qwen"),
            **values,
        }
        out = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=False), contextlib.redirect_stdout(out):
            self.module.init_qwen_tts()
        return out.getvalue()

    def test_cpu_installs_do_not_download_the_qwen_checkpoint(self):
        with mock.patch.dict(sys.modules, {"huggingface_hub": types.SimpleNamespace(snapshot_download=self.fail)}):
            output = self.run_with_env(engine="piper")
        self.assertIn("Qwen TTS not selected", output)

    def test_present_checkpoint_is_reused(self):
        model_dir = self.root / "qwen"
        model_dir.mkdir()
        (model_dir / "model.safetensors").write_bytes(b"weights")
        with mock.patch.dict(sys.modules, {"huggingface_hub": types.SimpleNamespace(snapshot_download=self.fail)}):
            output = self.run_with_env(engine="qwen", QWEN_TTS_MODEL="Qwen/Qwen3-TTS-12Hz-1.7B-Base")
        self.assertIn("present", output)

    def test_gpu_install_downloads_into_the_configured_volume(self):
        calls = []

        def snapshot_download(**kwargs):
            calls.append(kwargs)

        with mock.patch.dict(sys.modules, {"huggingface_hub": types.SimpleNamespace(snapshot_download=snapshot_download)}):
            output = self.run_with_env(engine="qwen", QWEN_TTS_MODEL="Qwen/Qwen3-TTS-12Hz-1.7B-Base")
        self.assertIn("~4.5 GB", output)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["repo_id"], "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
        self.assertEqual(calls[0]["local_dir"], str(self.root / "qwen"))

    def fail(self, **_kwargs):
        raise AssertionError("snapshot_download must not be called")


if __name__ == "__main__":
    unittest.main()
