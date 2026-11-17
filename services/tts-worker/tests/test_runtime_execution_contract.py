from __future__ import annotations

import json
import subprocess
from pathlib import Path

from voice_tts_service.config.worker import WorkerConfig
from voice_tts_service.infrastructure.runner import JobRunner
from voice_tts_service.storage.worker_store import JobsDB


def _config(tmp_path: Path) -> WorkerConfig:
    return WorkerConfig(
        project_root=tmp_path,
        runtime_dir=tmp_path / "runtime",
        jobs_db=tmp_path / "runtime" / "jobs.db",
        input_dir=tmp_path / "runtime" / "inputs",
        output_dir=tmp_path / "runtime" / "output",
        segments_dir=tmp_path / "runtime" / "segments",
        python_exec="python.exe",
        ref_audio_path=tmp_path / "refs" / "voz.wav",
        ref_text_path=tmp_path / "refs" / "voz.txt",
        config_yaml_path=tmp_path / "config" / "default.yaml",
        internal_token="internal-token",
        queue_max=20,
        job_timeout_sec=1200,
        preset="balanced_default",
        device="cpu",
    )


class FakeRunner(JobRunner):
    def __init__(self, cfg: WorkerConfig, db: JobsDB, stdout_lines: list[str], returncode: int = 0) -> None:
        super().__init__(cfg=cfg, db=db)
        self.stdout_lines = stdout_lines
        self.returncode = returncode
        self.commands: list[list[str]] = []

    def _run_with_live_progress(self, cmd: list[str], on_stdout_line) -> subprocess.CompletedProcess:
        self.commands.append(cmd)
        for line in self.stdout_lines:
            on_stdout_line(line)
        return subprocess.CompletedProcess(cmd, self.returncode, stdout="".join(self.stdout_lines), stderr="")


class TimeoutRunner(FakeRunner):
    def _run_with_live_progress(self, cmd: list[str], on_stdout_line) -> subprocess.CompletedProcess:
        self.commands.append(cmd)
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=self.cfg.job_timeout_sec)


def test_runner_builds_stable_cli_command_and_finishes_with_report_artifact(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    cfg.input_dir.mkdir(parents=True)
    cfg.output_dir.mkdir(parents=True)
    db = JobsDB(tmp_path / "jobs.db")
    db.create_job("job_done", "Texto suficientemente largo para sintetizar.", "me", "golazo_emotivo")
    (cfg.input_dir / "job_done.txt").write_text("Texto suficientemente largo para sintetizar.", encoding="utf-8")
    wav = cfg.output_dir / "1_7B" / "job_done.wav"
    wav.parent.mkdir(parents=True)
    wav.write_bytes(b"RIFFdoneWAVE")
    report = cfg.output_dir / "1_7B" / "job_done.report.json"
    report.write_text(json.dumps({"output": str(wav)}), encoding="utf-8")
    runner = FakeRunner(cfg, db, ["PROGRESS|stage=synthesizing|percent=42\n", "OK - segmentos: 2\n", "synth segment 1\n"])

    runner._run_one("job_done")

    command = runner.commands[0]
    assert command[:3] == ["python.exe", str(tmp_path / "src" / "main.py"), "--input"]
    assert command[command.index("--run-id") + 1] == "job_done"
    assert command[command.index("--preset") + 1] == "golazo_emotivo"
    assert command[command.index("--device") + 1] == "cpu"
    row = db.get_job("job_done")
    assert row is not None
    assert row["status"] == "done"
    assert row["progress_percent"] == 100
    assert row["output_wav_path"] == str(wav)
    assert row["output_report_path"] == str(report.resolve())


def test_runner_maps_subprocess_failure_to_tts_failed_with_stage_tail(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    cfg.input_dir.mkdir(parents=True)
    db = JobsDB(tmp_path / "jobs.db")
    db.create_job("job_fail", "Texto suficientemente largo para fallar.", "me", "balanced_default")
    (cfg.input_dir / "job_fail.txt").write_text("Texto suficientemente largo para fallar.", encoding="utf-8")
    runner = FakeRunner(cfg, db, ["PROGRESS|stage=preparing_reference|percent=20\n"], returncode=7)

    runner._run_one("job_fail")

    row = db.get_job("job_fail")
    assert row is not None
    assert row["status"] == "error"
    assert row["error_code"] == "TTS_FAILED"
    assert "stage=preparing_reference_failed" in row["error_message"]


def test_runner_maps_timeout_to_worker_timeout_without_real_process(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    cfg.input_dir.mkdir(parents=True)
    db = JobsDB(tmp_path / "jobs.db")
    db.create_job("job_timeout", "Texto suficientemente largo para timeout.", "me", "balanced_default")
    (cfg.input_dir / "job_timeout.txt").write_text("Texto suficientemente largo para timeout.", encoding="utf-8")
    runner = TimeoutRunner(cfg, db, [])

    runner._run_one("job_timeout")

    row = db.get_job("job_timeout")
    assert row is not None
    assert row["status"] == "error"
    assert row["error_code"] == "WORKER_TIMEOUT"
    assert row["error_message"] == "The job exceeded its maximum timeout."


def test_runner_maps_missing_and_invalid_reports_to_stable_errors(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    cfg.input_dir.mkdir(parents=True)
    cfg.output_dir.mkdir(parents=True)
    db = JobsDB(tmp_path / "jobs.db")

    db.create_job("job_no_report", "Texto suficientemente largo sin reporte.", "me", "balanced_default")
    (cfg.input_dir / "job_no_report.txt").write_text("Texto suficientemente largo sin reporte.", encoding="utf-8")
    FakeRunner(cfg, db, [])._run_one("job_no_report")
    missing_report = db.get_job("job_no_report")
    assert missing_report is not None
    assert missing_report["status"] == "error"
    assert missing_report["error_code"] == "MISSING_REPORT"

    db.create_job("job_bad_report", "Texto suficientemente largo con reporte inválido.", "me", "balanced_default")
    (cfg.input_dir / "job_bad_report.txt").write_text("Texto suficientemente largo con reporte inválido.", encoding="utf-8")
    bad_report = cfg.output_dir / "job_bad_report.report.json"
    bad_report.write_text("{invalid-json", encoding="utf-8")
    FakeRunner(cfg, db, [])._run_one("job_bad_report")
    invalid_report = db.get_job("job_bad_report")
    assert invalid_report is not None
    assert invalid_report["status"] == "error"
    assert invalid_report["error_code"] == "INVALID_REPORT"


def test_runner_maps_missing_report_output_and_missing_artifact_to_stable_errors(tmp_path: Path) -> None:
    cfg = _config(tmp_path)
    cfg.input_dir.mkdir(parents=True)
    cfg.output_dir.mkdir(parents=True)
    db = JobsDB(tmp_path / "jobs.db")

    db.create_job("job_missing_output", "Texto suficientemente largo sin output.", "me", "balanced_default")
    (cfg.input_dir / "job_missing_output.txt").write_text("Texto suficientemente largo sin output.", encoding="utf-8")
    (cfg.output_dir / "job_missing_output.report.json").write_text(json.dumps({"segments": 2}), encoding="utf-8")
    FakeRunner(cfg, db, [])._run_one("job_missing_output")
    missing_output = db.get_job("job_missing_output")
    assert missing_output is not None
    assert missing_output["status"] == "error"
    assert missing_output["error_code"] == "MISSING_OUTPUT"

    db.create_job("job_missing_artifact", "Texto suficientemente largo sin wav.", "me", "balanced_default")
    (cfg.input_dir / "job_missing_artifact.txt").write_text("Texto suficientemente largo sin wav.", encoding="utf-8")
    missing_wav = cfg.output_dir / "missing.wav"
    (cfg.output_dir / "job_missing_artifact.report.json").write_text(json.dumps({"output": str(missing_wav)}), encoding="utf-8")
    FakeRunner(cfg, db, [])._run_one("job_missing_artifact")
    missing_artifact = db.get_job("job_missing_artifact")
    assert missing_artifact is not None
    assert missing_artifact["status"] == "error"
    assert missing_artifact["error_code"] == "MISSING_ARTIFACT"
