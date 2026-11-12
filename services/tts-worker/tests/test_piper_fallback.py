from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from voice_tts_service.domain.segmenter import Segment
from voice_tts_service.infrastructure.engine_factory import (
    ENGINE_PIPER,
    ENGINE_QWEN,
    TTSEngineError,
    create_tts_engine,
    resolve_engine_mode,
)
from voice_tts_service.infrastructure.piper import PiperEngine, PiperUnavailable


def _segment(text: str = "Hola mundo") -> Segment:
    return Segment(
        index=1,
        paragraph_index=0,
        text=text,
        word_count=len(text.split()),
        char_count=len(text),
        pause_after_ms=0,
    )


def test_resolve_engine_mode_prefers_env_and_falls_back_to_auto() -> None:
    assert resolve_engine_mode({"TTS_WORKER_ENGINE": "piper"}, {}) == ENGINE_PIPER
    assert resolve_engine_mode({}, {"engine": "qwen"}) == ENGINE_QWEN
    assert resolve_engine_mode({}, {}) == "auto"
    assert resolve_engine_mode({"TTS_WORKER_ENGINE": "bogus"}, {}) == "auto"


def test_piper_engine_runs_cpu_cli_and_returns_native_sample_rate(tmp_path: Path) -> None:
    model = tmp_path / "voice.onnx"
    model.write_bytes(b"model")
    calls = []

    def runner(command, **kwargs):
        calls.append({"command": command, "input": kwargs.get("input")})
        sf.write(command[command.index("--output_file") + 1], np.zeros(160, dtype=np.float32), 22050)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    engine = PiperEngine(
        {"piper_model": str(model), "piper_length_scale": 1.1},
        binary="piper",
        runner=runner,
    )
    engine.prepare_reference(tmp_path / "ref.wav", "texto")
    output = tmp_path / "out.wav"

    assert engine.synthesize_to_file(_segment("Buenas"), output) == 22050
    assert calls[0]["command"][:2] == ["piper", "--model"]
    assert calls[0]["command"][-2:] == ["--length_scale", "1.1"]
    assert calls[0]["input"] == "Buenas"


def test_piper_engine_reports_missing_model_and_failed_process(tmp_path: Path) -> None:
    with pytest.raises(PiperUnavailable):
        PiperEngine({}, runner=lambda *a, **k: None).prepare_reference(tmp_path / "ref.wav", "x")

    model = tmp_path / "voice.onnx"
    model.write_bytes(b"model")
    engine = PiperEngine(
        {"piper_model": str(model)},
        binary="piper",
        runner=lambda *a, **k: SimpleNamespace(returncode=2, stdout="", stderr="bad voice"),
    )
    with pytest.raises(PiperUnavailable, match="bad voice"):
        engine.synthesize_to_file(_segment(), tmp_path / "out.wav")


class _FakeSlot:
    def __init__(self):
        self.acquired = 0
        self.released = 0

    def acquire(self):
        self.acquired += 1
        return self

    def release(self):
        self.released += 1


class _FakeEngine:
    def __init__(self, name):
        self.name = name


def test_create_engine_uses_qwen_on_gpu_and_returns_slot(tmp_path, monkeypatch) -> None:
    created = {}

    def qwen_factory(cfg, device):
        created["qwen"] = (cfg, device)
        return _FakeEngine("qwen")

    engine, slot = create_tts_engine(
        {"model_name": "qwen"},
        device="cuda:0",
        env={"NEWSROOM_GPU_LOCK_PATH": str(tmp_path / "gpu.lock")},
        qwen_factory=qwen_factory,
    )

    assert engine.name == "qwen"
    assert slot is not None and slot.acquired is True
    slot.release()
    assert created["qwen"] == ({"model_name": "qwen"}, "cuda:0")


def test_create_engine_falls_back_to_piper_when_qwen_fails(tmp_path) -> None:
    calls = []

    def broken_qwen(cfg, device):
        raise RuntimeError("CUDA out of memory")

    def piper_factory(cfg, device):
        calls.append(device)
        return _FakeEngine("piper")

    engine, slot = create_tts_engine(
        {"piper_model": str(tmp_path / "voice.onnx")},
        env={
            "NEWSROOM_GPU_LOCK_PATH": str(tmp_path / "gpu.lock"),
            "PIPER_MODEL": str(tmp_path / "voice.onnx"),
        },
        qwen_factory=broken_qwen,
        piper_factory=piper_factory,
    )

    assert engine.name == "piper"
    assert slot is None
    assert calls == [None]


def test_create_engine_honours_explicit_piper_mode_without_gpu_slot(tmp_path) -> None:
    engine, slot = create_tts_engine(
        {},
        env={"TTS_WORKER_ENGINE": "piper", "PIPER_MODEL": "/voices/es.onnx"},
        piper_factory=lambda cfg, device: _FakeEngine("piper"),
    )

    assert engine.name == "piper"
    assert slot is None


def test_create_engine_fails_when_qwen_fails_without_fallback(tmp_path) -> None:
    with pytest.raises(TTSEngineError, match="no Piper fallback"):
        create_tts_engine(
            {},
            env={"NEWSROOM_GPU_LOCK_PATH": str(tmp_path / "gpu.lock")},
            qwen_factory=lambda cfg, device: (_ for _ in ()).throw(RuntimeError("no cuda")),
        )


def test_create_engine_qwen_mode_can_disable_cpu_fallback(tmp_path) -> None:
    with pytest.raises(TTSEngineError, match="Qwen TTS unavailable"):
        create_tts_engine(
            {"piper_model": "/voices/es.onnx"},
            env={
                "TTS_WORKER_ENGINE": "qwen",
                "TTS_WORKER_ALLOW_CPU_FALLBACK": "0",
                "NEWSROOM_GPU_LOCK_PATH": str(tmp_path / "gpu.lock"),
            },
            qwen_factory=lambda cfg, device: (_ for _ in ()).throw(RuntimeError("no cuda")),
        )


def test_resolve_engine_mode_uses_piper_for_the_local_cpu_mode() -> None:
    assert resolve_engine_mode({"NEWSROOM_MODE": "local"}, {}) == ENGINE_PIPER
    assert resolve_engine_mode({"NEWSROOM_MODE": "local", "TTS_WORKER_ENGINE": "qwen"}, {}) == ENGINE_QWEN
    assert resolve_engine_mode({"NEWSROOM_MODE": "demo"}, {}) == "auto"


def test_piper_engine_reads_the_model_path_from_the_environment(monkeypatch, tmp_path) -> None:
    model = tmp_path / "es_ES-davefx-medium.onnx"
    model.write_bytes(b"fake")
    monkeypatch.setenv("PIPER_MODEL", str(model))
    monkeypatch.delenv("PIPER_BIN", raising=False)

    engine = PiperEngine({})

    engine.prepare_reference(tmp_path / "unused.wav", "")
    assert engine.model_path == model
