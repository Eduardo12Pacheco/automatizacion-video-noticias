from __future__ import annotations

import json
import queue
import subprocess
import threading
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

        try:
            self.db.set_progress(job_id, "synthesizing")
            result = subprocess.run(
                cmd,
                cwd=self.cfg.project_root,
                capture_output=True,
                text=True,
                timeout=self.cfg.job_timeout_sec,
                check=False,
            )
        except subprocess.TimeoutExpired:
            self.db.set_error(job_id, "WORKER_TIMEOUT", "El job superó el timeout máximo.")
            return
        except Exception as exc:
            self.db.set_error(job_id, "INTERNAL_ERROR", f"Error ejecutando TTS: {exc}")
            return

        if result.returncode != 0:
            error_message = (result.stderr or result.stdout or "Error desconocido")[-2000:]
            self.db.set_error(job_id, "TTS_FAILED", error_message)
            return

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

    def _find_report(self, job_id: str) -> Path | None:
        matches = list(self.cfg.output_dir.glob(f"**/{job_id}.report.json"))
        if not matches:
            return None
        return sorted(matches)[-1]
