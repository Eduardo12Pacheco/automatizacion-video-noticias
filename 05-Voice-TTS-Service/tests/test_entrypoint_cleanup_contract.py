from __future__ import annotations

from pathlib import Path

import yaml

from voice_tts_service.config.orchestrator import load_config as load_orchestrator_config
from voice_tts_service.config.worker import WorkerConfig, load_config as load_worker_config
from voice_tts_service.infrastructure.runner import JobRunner
from voice_tts_service.storage.worker_store import JobsDB


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def _read(relative_path: str) -> str:
    return (SERVICE_ROOT / relative_path).read_text(encoding="utf-8")


def test_service_scripts_prefer_canonical_fastapi_modules_and_preserve_runtime_contract() -> None:
    worker = _read("scripts/run-worker.ps1")
    orchestrator = _read("scripts/run-orchestrator.ps1")
    install_services = _read("scripts/install-services.ps1")

    assert "voice_tts_service.api.worker_app:app" in worker
    assert "voice_tts_service.api.orchestrator_app:app" in orchestrator
    assert "-m uvicorn app:app" not in worker
    assert "-m uvicorn app:app" not in orchestrator

    assert "Set-Location $serviceRoot" in worker
    assert "Set-Location $serviceRoot" in orchestrator
    assert "--host 127.0.0.1 --port 8091" in worker
    assert "--host 127.0.0.1 --port 8088" in orchestrator
    assert "TTS_WORKER_INTERNAL_TOKEN" in worker
    assert "TTS_WORKER_INTERNAL_TOKEN" in orchestrator
    assert "TTS_ORCH_WORKER_INTERNAL_TOKEN = $env:TTS_WORKER_INTERNAL_TOKEN" in orchestrator

    for service_name in ("tts-worker", "tts-orchestrator", "tts-tunnel"):
        assert f"-Name '{service_name}'" in install_services
        assert f"'{service_name}.out.log'" in install_services
        assert f"'{service_name}.err.log'" in install_services


def test_docs_label_canonical_entrypoints_primary_and_wrappers_compatibility_only() -> None:
    docs = {
        "README.md": _read("README.md"),
        "NSSM-SERVICES-RUNBOOK.md": _read("NSSM-SERVICES-RUNBOOK.md"),
        "tts-worker/README.md": _read("tts-worker/README.md"),
        "tts-orchestrator/README.md": _read("tts-orchestrator/README.md"),
    }

    assert "voice_tts_service.api.worker_app:app" in docs["README.md"]
    assert "voice_tts_service.api.orchestrator_app:app" in docs["README.md"]
    assert "compatibilidad deprecada" in docs["README.md"].lower()
    assert "no borrar" in docs["README.md"].lower()

    assert "voice_tts_service.api.worker_app:app" in docs["NSSM-SERVICES-RUNBOOK.md"]
    assert "voice_tts_service.api.orchestrator_app:app" in docs["NSSM-SERVICES-RUNBOOK.md"]
    assert "tts-worker`" in docs["NSSM-SERVICES-RUNBOOK.md"]
    assert "tts-orchestrator`" in docs["NSSM-SERVICES-RUNBOOK.md"]
    assert "runtime-logs/services/tts-worker.out.log" in docs["NSSM-SERVICES-RUNBOOK.md"]

    assert "uvicorn voice_tts_service.api.worker_app:app --host 127.0.0.1 --port 8091" in docs["tts-worker/README.md"]
    assert "uvicorn app:app --host 127.0.0.1 --port 8091" in docs["tts-worker/README.md"]
    assert "compatibilidad deprecada" in docs["tts-worker/README.md"].lower()

    assert "uvicorn voice_tts_service.api.orchestrator_app:app --host 127.0.0.1 --port 8088" in docs["tts-orchestrator/README.md"]
    assert "uvicorn app:app --host 127.0.0.1 --port 8088" in docs["tts-orchestrator/README.md"]
    assert "compatibilidad deprecada" in docs["tts-orchestrator/README.md"].lower()


def test_voice_defaults_presets_and_artifact_contract_are_unchanged(monkeypatch) -> None:
    for name in list(__import__("os").environ):
        if name.startswith("TTS_"):
            monkeypatch.delenv(name, raising=False)

    cfg = yaml.safe_load((SERVICE_ROOT / "config" / "default.yaml").read_text(encoding="utf-8"))

    assert cfg["segmenter"] == {
        "mode": "sentence_first",
        "min_words_per_segment": 20,
        "max_words_per_segment": 40,
        "hard_max_words_per_segment": 50,
    }
    assert cfg["pauses_ms"] == {
        "comma": 120,
        "semicolon": 180,
        "colon": 180,
        "period": 260,
        "question": 300,
        "exclamation": 300,
        "paragraph_break": 700,
        "default": 220,
    }
    assert cfg["assembler"] == {
        "crossfade_ms": 30,
        "output_gain_db": 5.0,
        "peak_protection": True,
        "peak_target": 0.99,
        "trim_silence": {
            "enabled": True,
            "threshold": 0.005,
            "min_silence_ms": 180,
            "trim_leading": True,
            "trim_trailing": True,
        },
    }
    assert cfg["generation"] == {
        "model_name": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        "language": "Spanish",
        "use_flash_attention": False,
        "dtype": "bfloat16",
        "preset": "balanced_default",
        "max_new_tokens": 2048,
        "do_sample": None,
        "top_k": None,
        "top_p": None,
        "temperature": None,
        "repetition_penalty": None,
        "subtalker_dosample": None,
        "subtalker_top_k": None,
        "subtalker_top_p": None,
        "subtalker_temperature": None,
    }
    assert cfg["presets"]["balanced_default"] == {
        "do_sample": True,
        "top_k": 50,
        "top_p": 0.94,
        "temperature": 0.82,
        "repetition_penalty": 1.06,
        "subtalker_dosample": True,
        "subtalker_top_k": 50,
        "subtalker_top_p": 0.95,
        "subtalker_temperature": 0.84,
        "max_new_tokens": 2048,
    }
    assert sorted(cfg["presets"]) == ["balanced_default", "golazo_emotivo", "golazo_informativo"]

    worker_cfg = load_worker_config()
    assert worker_cfg.runtime_dir == SERVICE_ROOT / "tts-worker" / "runtime"
    assert worker_cfg.input_dir == SERVICE_ROOT / "tts-worker" / "runtime" / "inputs"
    assert worker_cfg.output_dir == SERVICE_ROOT / "tts-worker" / "runtime" / "output"
    assert worker_cfg.segments_dir == SERVICE_ROOT / "tts-worker" / "runtime" / "segments"
    assert worker_cfg.ref_audio_path == SERVICE_ROOT / "refs" / "voz.wav"
    assert worker_cfg.ref_text_path == SERVICE_ROOT / "refs" / "voz.txt"
    assert worker_cfg.config_yaml_path == SERVICE_ROOT / "config" / "default.yaml"
    assert worker_cfg.queue_max == 20
    assert worker_cfg.job_timeout_sec == 1200

    orchestrator_cfg = load_orchestrator_config()
    assert orchestrator_cfg.runtime_dir == SERVICE_ROOT / "tts-orchestrator" / "runtime"
    assert orchestrator_cfg.worker_base_url == "http://127.0.0.1:8091"
    assert orchestrator_cfg.request_timeout_sec == 30
    assert orchestrator_cfg.poll_timeout_sec == 30
    assert orchestrator_cfg.rate_limit_per_min == 10
    assert orchestrator_cfg.queue_max_hint == 20
    assert orchestrator_cfg.stream_poll_interval_sec == 2
    assert orchestrator_cfg.stream_heartbeat_sec == 15
    assert orchestrator_cfg.allowed_origins == ["http://localhost:8080"]


def test_job_runner_keeps_wrapper_compatible_cli_command_and_voice_args(tmp_path: Path) -> None:
    cfg = WorkerConfig(
        project_root=tmp_path,
        runtime_dir=tmp_path / "tts-worker" / "runtime",
        jobs_db=tmp_path / "tts-worker" / "runtime" / "jobs.db",
        input_dir=tmp_path / "tts-worker" / "runtime" / "inputs",
        output_dir=tmp_path / "tts-worker" / "runtime" / "output",
        segments_dir=tmp_path / "tts-worker" / "runtime" / "segments",
        python_exec="python.exe",
        ref_audio_path=tmp_path / "refs" / "voz.wav",
        ref_text_path=tmp_path / "refs" / "voz.txt",
        config_yaml_path=tmp_path / "config" / "default.yaml",
        internal_token="internal-token",
        queue_max=20,
        job_timeout_sec=1200,
        preset="balanced_default",
        device="cuda:0",
    )
    command = JobRunner(cfg=cfg, db=JobsDB(tmp_path / "jobs.db"))._build_command(
        job_id="job_keep_contract",
        input_file=cfg.input_dir / "job_keep_contract.txt",
        voice_profile="golazo_informativo",
    )

    assert command == [
        "python.exe",
        str(tmp_path / "src" / "main.py"),
        "--input", str(cfg.input_dir / "job_keep_contract.txt"),
        "--ref-audio", str(cfg.ref_audio_path),
        "--ref-text", str(cfg.ref_text_path),
        "--config", str(cfg.config_yaml_path),
        "--output-dir", str(cfg.output_dir),
        "--segments-dir", str(cfg.segments_dir),
        "--run-id", "job_keep_contract",
        "--preset", "golazo_informativo",
        "--device", "cuda:0",
    ]


def test_cli_report_schema_and_output_naming_are_stable_without_model_execution() -> None:
    synthesize = _read("voice_tts_service/cli/synthesize.py")

    for expected_literal in (
        "{run_id}.wav",
        "{run_id}.report.json",
        "seg_{segment.index:03d}.wav",
        "sample_rate",
        "sample_rate_native_model",
        "model_output_tag",
        "preset_used",
        "preset_values",
        "segment_audio_analysis",
        "benchmark",
        "audio_output",
        "segment_count",
    ):
        assert expected_literal in synthesize
