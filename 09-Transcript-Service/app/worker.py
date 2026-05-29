from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Protocol

from .catalog import expand_catalog
from .exporter import build_export_text, build_summary
from .mention_engine import find_mentions
from .models import TranscriptSegment
from .settings import Settings
from .store import JobStore, JobStoreError


class DependencyFailure(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def normalize_language(language: str | None) -> str | None:
    value = (language or "").strip().casefold()
    if not value:
        return None
    return value.replace("_", "-").split("-", 1)[0]


class Downloader(Protocol):
    def download(self, url: str, job_dir: Path) -> Path: ...


class AudioExtractor(Protocol):
    def extract_16khz_wav(self, source_path: Path, audio_dir: Path) -> Path: ...


class Transcriber(Protocol):
    def transcribe(self, audio_path: Path): ...


def _resolve_download_result(downloaded: Any) -> tuple[Path, str | None]:
    if isinstance(downloaded, Path):
        return downloaded, None
    if isinstance(downloaded, dict):
        path = downloaded.get("path") or downloaded.get("source_path")
        title = downloaded.get("title")
        return Path(path), str(title).strip() if title else None
    path = getattr(downloaded, "path", None) or getattr(downloaded, "source_path", None)
    title = getattr(downloaded, "title", None)
    if path is None:
        raise DependencyFailure("invalid_download_contract", "Downloader must return a path or metadata with a path")
    return Path(path), str(title).strip() if title else None


class TranscriptWorker:
    def __init__(
        self,
        *,
        settings: Settings,
        store: JobStore,
        downloader: Downloader,
        audio_extractor: AudioExtractor,
        transcriber: Transcriber,
    ):
        self.settings = settings
        self.store = store
        self.downloader = downloader
        self.audio_extractor = audio_extractor
        self.transcriber = transcriber
        self._busy_lock = threading.Lock()
        self.busy = False

    @property
    def queue_depth(self) -> int:
        return 1 if self.busy else 0

    def enqueue(self, job_id: str) -> None:
        with self._busy_lock:
            if self.busy:
                raise RuntimeError("worker_busy")
            self.busy = True
        thread = threading.Thread(target=self.process, args=(job_id,), daemon=True)
        thread.start()

    def process(self, job_id: str) -> None:
        with self._busy_lock:
            self.busy = True
        try:
            if self.store.should_stop(job_id):
                return
            job = self.store.mark_running(job_id)
            job_dir = self.store.jobs_dir / job_id
            if self.store.should_stop(job_id):
                return
            downloaded = self.downloader.download(job.url, job_dir)
            source_path, title = _resolve_download_result(downloaded)
            if title:
                self.store.update_metadata(job_id, title=title)
            if self.store.should_stop(job_id):
                return
            audio_path = self.audio_extractor.extract_16khz_wav(source_path, job_dir / "audio")
            if audio_path.name != "audio-16khz.wav":
                raise DependencyFailure("invalid_audio_contract", "STT input must be audio/audio-16khz.wav")
            if self.store.should_stop(job_id):
                return
            transcribed = self.transcriber.transcribe(audio_path)
            if isinstance(transcribed, tuple):
                segments, detected_language = transcribed
            else:
                segments, detected_language = transcribed, None
            detected_language = normalize_language(detected_language)
            self.store.update_metadata(job_id, detected_language=detected_language)
            self.store.save_transcript(job_id, segments, detected_language=detected_language)
            if self.store.should_stop(job_id):
                return
            current = self.store.get_job(job_id)
            catalog_entries = expand_catalog(current.selected_countries, detected_language)
            variants_used = {entry.canonical: entry.variants for entry in catalog_entries}
            matches = find_mentions(
                segments,
                target=current.target,
                countries=current.selected_countries,
                detected_language=detected_language,
                extra_keywords=current.extra_keywords,
            )
            self.store.save_mentions(job_id, matches, detected_language=detected_language)
            summary = build_summary(matches)
            summary["detected_language"] = detected_language
            self.store.save_summary(job_id, summary)
            self.store.update_metadata(job_id, variants_used=variants_used)
            transcript = self.store.get_transcript(job_id)
            self.store.save_export_text(
                job_id,
                build_export_text(
                    title=current.title,
                    selected_countries=current.selected_countries,
                    detected_language=detected_language,
                    variants_used=variants_used,
                    summary=summary,
                    transcript=transcript,
                ),
            )
            self.store.mark_succeeded(job_id)
        except DependencyFailure as exc:
            self.store.mark_failed(job_id, code=exc.code, message=exc.message)
        except JobStoreError as exc:
            self.store.mark_failed(job_id, code=exc.code, message=exc.message)
        except Exception as exc:
            self.store.mark_failed(job_id, code="worker_failed", message=type(exc).__name__)
        finally:
            with self._busy_lock:
                self.busy = False
