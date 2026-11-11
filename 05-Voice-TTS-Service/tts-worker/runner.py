from __future__ import annotations

import json
import queue
import subprocess
import threading
import re
from pathlib import Path

from config import WorkerConfig
from db import JobsDB


class QueueFullError(RuntimeError):
    pass


class JobRunner:
    def __init__(self, cfg: WorkerConfig, db: JobsDB):
        self.cfg = cfg
        self.db = db
        self._queue: queue.Queue[str] = queue.Queue()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def enqueue(self, job_id: str, text: str, requested_by: str | None, voice_profile: str) -> None:
        if self.db.count_active() >= self.cfg.queue_max:
            raise QueueFullError("La cola está llena")

        existing = self.db.get_job(job_id)
        if existing is not None:
            return

        self.db.create_job(job_id=job_id, text=text, requested_by=requested_by, voice_profile=voice_profile)
        input_file = self.cfg.input_dir / f"{job_id}.txt"
        input_file.write_text(text, encoding="utf-8")
        self._queue.put(job_id)

    def queue_position(self, job_id: str) -> int | None:
        queued = list(self._queue.queue)
        if job_id not in queued:
            return None
        return queued.index(job_id) + 1

    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
            try:
                self._run_one(job_id)
            finally:
                self._queue.task_done()

    def _run_one(self, job_id: str) -> None:
        self.db.set_running(job_id)
        row = self.db.get_job(job_id) or {}
        voice_profile = str(row.get("voice_profile") or "").strip()
        input_file = self.cfg.input_dir / f"{job_id}.txt"
        if not input_file.exists():
            self.db.set_error(job_id, "INVALID_INPUT", "No se encontró archivo de texto del job.")
            return

        cmd = [
            self.cfg.python_exec,
            str(self.cfg.project_root / "src" / "main.py"),
            "--input",
            str(input_file),
            "--ref-audio",
            str(self.cfg.ref_audio_path),
            "--ref-text",
            str(self.cfg.ref_text_path),
            "--config",
            str(self.cfg.config_yaml_path),
            "--output-dir",
            str(self.cfg.output_dir),
            "--segments-dir",
            str(self.cfg.segments_dir),
            "--run-id",
            job_id,
        ]
        resolved_preset = voice_profile or self.cfg.preset
        if resolved_preset:
            cmd.extend(["--preset", resolved_preset])
        if self.cfg.device:
            cmd.extend(["--device", self.cfg.device])

        result = None
        stdout_buffer: list[str] = []

        def stream_progress(line: str) -> None:
            stdout_buffer.append(line)
            self._update_progress_from_log_line(job_id, line)

        try:
            self.db.set_progress(job_id, "loading_model", 10)
            result = self._run_with_live_progress(cmd, stream_progress)
        except subprocess.TimeoutExpired:
            self.db.set_error(job_id, "WORKER_TIMEOUT", "El job superó el timeout máximo.")
            return
        except Exception as exc:
            self.db.set_error(job_id, "INTERNAL_ERROR", f"Error ejecutando TTS: {exc}")
            return

        if result is None:
            self.db.set_error(job_id, "INTERNAL_ERROR", "No se pudo ejecutar el proceso de síntesis.")
            return

        if result.returncode != 0:
            failure_stage = self._infer_failure_stage(stdout_buffer)
            error_message = self._build_subprocess_error_message(
                returncode=result.returncode,
                failure_stage=failure_stage,
                stdout_text=result.stdout,
                stderr_text=result.stderr,
            )
            self.db.set_error(job_id, "TTS_FAILED", error_message)
            return

        self._apply_progress_from_stdout(job_id, "\n".join(stdout_buffer) or result.stdout)

        report_path = self._find_report(job_id)
        if report_path is None:
            self.db.set_error(job_id, "MISSING_REPORT", "No se encontró reporte generado.")
            return

        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except Exception as exc:
            self.db.set_error(job_id, "INVALID_REPORT", f"No se pudo leer reporte: {exc}")
            return

        output_value = str(report.get("output", "")).strip()
        if not output_value:
            self.db.set_error(job_id, "MISSING_OUTPUT", "El reporte no contiene ruta de output.")
            return

        output_wav = Path(output_value)
        if not output_wav.is_absolute():
            output_wav = (self.cfg.project_root / output_wav).resolve()

        if not output_wav.exists():
            self.db.set_error(job_id, "MISSING_ARTIFACT", "El archivo WAV no existe.")
            return

        self.db.set_done(job_id, str(output_wav), str(report_path.resolve()))

    def _apply_progress_from_stdout(self, job_id: str, stdout: str | None) -> None:
        if not stdout:
            return

        total_segments = None
        done_segments = 0
        for line in stdout.splitlines():
            l = line.strip().lower()
            if l.startswith("ok - segmentos:"):
                m = re.search(r"(\d+)", l)
                if m:
                    total_segments = max(1, int(m.group(1)))
            elif "synth segment" in l:
                done_segments += 1

        if total_segments and done_segments:
            ratio = min(1.0, done_segments / total_segments)
            percent = 20 + int(ratio * 75)
            self.db.set_progress(job_id, "synthesizing", percent)
        elif total_segments:
            self.db.set_progress(job_id, "synthesizing", 55)

    def _update_progress_from_log_line(self, job_id: str, line: str) -> None:
        lower = (line or "").strip().lower()
        if not lower:
            return

        if lower.startswith("progress|"):
            parts = {}
            for token in lower.split("|")[1:]:
                if "=" not in token:
                    continue
                k, v = token.split("=", 1)
                parts[k.strip()] = v.strip()
            stage = parts.get("stage") or "running"
            raw_percent = parts.get("percent")
            if raw_percent and raw_percent.isdigit():
                self.db.set_progress(job_id, stage, int(raw_percent))
            else:
                self.db.set_progress(job_id, stage)
            return

        if "loading" in lower and "model" in lower:
            self.db.set_progress(job_id, "loading_model", 12)
            return

        if "prepare" in lower and "reference" in lower:
            self.db.set_progress(job_id, "preparing_reference", 20)
            return

        if "synth" in lower or "segment" in lower:
            current = self.db.get_job(job_id) or {}
            previous = int(current.get("progress_percent") or 25)
            next_value = max(previous, min(95, previous + 3))
            self.db.set_progress(job_id, "synthesizing", next_value)

    def _run_with_live_progress(self, cmd: list[str], on_stdout_line) -> subprocess.CompletedProcess:
        proc = subprocess.Popen(
            cmd,
            cwd=self.cfg.project_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            universal_newlines=True,
        )

        stderr_lines: list[str] = []

        def read_stderr() -> None:
            if proc.stderr is None:
                return
            for line in proc.stderr:
                stderr_lines.append(line)

        stderr_thread = threading.Thread(target=read_stderr, daemon=True)
        stderr_thread.start()

        stdout_lines: list[str] = []
        if proc.stdout is not None:
            for line in proc.stdout:
                stdout_lines.append(line)
                on_stdout_line(line)

        try:
            proc.wait(timeout=self.cfg.job_timeout_sec)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise
        finally:
            stderr_thread.join(timeout=2)

        return subprocess.CompletedProcess(
            args=cmd,
            returncode=proc.returncode,
            stdout="".join(stdout_lines),
            stderr="".join(stderr_lines),
        )

    def _infer_failure_stage(self, stdout_lines: list[str]) -> str:
        last_stage = "unknown"
        for raw_line in stdout_lines:
            line = (raw_line or "").strip().lower()
            if not line.startswith("progress|"):
                continue
            for token in line.split("|")[1:]:
                if "=" not in token:
                    continue
                key, value = token.split("=", 1)
                if key.strip() == "stage":
                    stage_value = value.strip() or "unknown"
                    last_stage = stage_value
        return f"{last_stage}_failed"

    def _build_subprocess_error_message(
        self,
        returncode: int,
        failure_stage: str,
        stdout_text: str | None,
        stderr_text: str | None,
    ) -> str:
        stdout_tail = self._tail_lines(stdout_text, 20)
        stderr_tail = self._tail_lines(stderr_text, 20)

        parts = [
            f"Subprocess failed at stage={failure_stage} with returncode={returncode}",
            "--- stdout (last 20 lines) ---",
            stdout_tail or "(empty)",
            "--- stderr (last 20 lines) ---",
            stderr_tail or "(empty)",
        ]

        message = "\n".join(parts)
        if len(message) <= 2000:
            return message
        return message[-2000:]

    def _tail_lines(self, text: str | None, max_lines: int) -> str:
        if not text:
            return ""
        lines = text.splitlines()
        return "\n".join(lines[-max_lines:])

    def _find_report(self, job_id: str) -> Path | None:
        matches = list(self.cfg.output_dir.glob(f"**/{job_id}.report.json"))
        if not matches:
            return None
        return sorted(matches)[-1]
