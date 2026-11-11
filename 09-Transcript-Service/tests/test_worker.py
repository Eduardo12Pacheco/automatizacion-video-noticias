from __future__ import annotations

from pathlib import Path

from app.models import TranscriptSegment
from app.settings import Settings
from app.store import JobStore
from app.worker import DependencyFailure, TranscriptWorker


class FakeDownloader:
    def download(self, url: str, job_dir: Path) -> Path:
        source = job_dir / "source.mp4"
        source.write_text(f"downloaded {url}", encoding="utf-8")
        return source


class FakeMetadataDownloader:
    def download(self, url: str, job_dir: Path):
        source = job_dir / "source.mp4"
        source.write_text(f"downloaded {url}", encoding="utf-8")
        return {"path": source, "title": "Argentina vs Colombia Highlights"}


class FakeAudioExtractor:
    def extract_16khz_wav(self, source_path: Path, audio_dir: Path) -> Path:
        audio_dir.mkdir(parents=True, exist_ok=True)
        wav = audio_dir / "audio-16khz.wav"
        wav.write_text(source_path.name, encoding="utf-8")
        return wav


class RecordingTranscriber:
    def __init__(self):
        self.seen_audio_path: Path | None = None

    def transcribe(self, audio_path: Path):
        self.seen_audio_path = audio_path
        return [TranscriptSegment(id="s1", start_ms=3000, end_ms=6000, text="Lionel Messie gana.")], "fr"


def test_worker_transitions_job_and_uses_audio_16khz_wav_for_stt(tmp_path):
    store = JobStore(tmp_path)
    job = store.create_job(url="https://video.example/one", countries=["argentina"], extra_keywords=[])
    transcriber = RecordingTranscriber()
    worker = TranscriptWorker(
        settings=Settings(api_key="test-key", runtime_dir=tmp_path),
        store=store,
        downloader=FakeDownloader(),
        audio_extractor=FakeAudioExtractor(),
        transcriber=transcriber,
    )

    worker.process(job.job_id)

    assert store.get_job(job.job_id).status == "succeeded"
    assert store.get_job(job.job_id).detected_language == "fr"
    assert transcriber.seen_audio_path == tmp_path / "jobs" / job.job_id / "audio" / "audio-16khz.wav"
    assert store.get_transcript(job.job_id).text == "(00:03) Lionel Messie gana."
    assert store.get_mentions(job.job_id).matches[0].canonical == "Lionel Messi"
    assert store.get_summary(job.job_id)["items"][0]["label"] == "Lionel Messi"
    assert "Idioma detectado: fr" in store.get_export_text(job.job_id)


class UppercaseLanguageTranscriber:
    def transcribe(self, audio_path: Path):
        return [TranscriptSegment(id="s1", start_ms=0, end_ms=1000, text="Colombia presiona.")], "ES_mx"


def test_worker_normalizes_language_across_job_summary_transcript_and_export(tmp_path):
    store = JobStore(tmp_path)
    job = store.create_job(url="https://video.example/language", countries=["colombia"], extra_keywords=[])
    worker = TranscriptWorker(
        settings=Settings(api_key="test-key", runtime_dir=tmp_path),
        store=store,
        downloader=FakeDownloader(),
        audio_extractor=FakeAudioExtractor(),
        transcriber=UppercaseLanguageTranscriber(),
    )

    worker.process(job.job_id)

    assert store.get_job(job.job_id).detected_language == "es"
    assert store.get_transcript(job.job_id).detected_language == "es"
    assert store.get_summary(job.job_id)["detected_language"] == "es"
    assert "Idioma detectado: es" in store.get_export_text(job.job_id)


def test_worker_persists_title_from_downloader_metadata_without_real_yt_dlp(tmp_path):
    store = JobStore(tmp_path)
    job = store.create_job(url="https://video.example/titled", countries=["argentina"], extra_keywords=[])
    worker = TranscriptWorker(
        settings=Settings(api_key="test-key", runtime_dir=tmp_path),
        store=store,
        downloader=FakeMetadataDownloader(),
        audio_extractor=FakeAudioExtractor(),
        transcriber=RecordingTranscriber(),
    )

    worker.process(job.job_id)

    assert store.get_job(job.job_id).title == "Argentina vs Colombia Highlights"
    assert store.list_history()[0].title == "Argentina vs Colombia Highlights"
    assert "Título: Argentina vs Colombia Highlights" in store.get_export_text(job.job_id)


class FailingDownloader:
    def download(self, url: str, job_dir: Path) -> Path:
        raise DependencyFailure("yt_dlp_unavailable", "yt-dlp is not installed")


def test_worker_records_typed_dependency_failure_without_partial_success(tmp_path):
    store = JobStore(tmp_path)
    job = store.create_job(url="https://video.example/fail", countries=["argentina"], extra_keywords=[])
    worker = TranscriptWorker(
        settings=Settings(api_key="test-key", runtime_dir=tmp_path),
        store=store,
        downloader=FailingDownloader(),
        audio_extractor=FakeAudioExtractor(),
        transcriber=RecordingTranscriber(),
    )

    worker.process(job.job_id)

    failed = store.get_job(job.job_id)
    assert failed.status == "failed"
    assert failed.error == {"code": "yt_dlp_unavailable", "message": "yt-dlp is not installed"}
    assert store.get_transcript(job.job_id).segments == []


def test_worker_records_typed_store_failure_without_claiming_artifact_success(tmp_path, monkeypatch):
    store = JobStore(tmp_path)
    job = store.create_job(url="https://video.example/store-fail", countries=["argentina"], extra_keywords=[])
    original_replace = __import__("os").replace

    def fail_replace(source, destination):
        if getattr(destination, "name", "") == "transcript.json":
            raise OSError("disk full")
        return original_replace(source, destination)

    monkeypatch.setattr("app.store.os.replace", fail_replace)
    worker = TranscriptWorker(
        settings=Settings(api_key="test-key", runtime_dir=tmp_path),
        store=store,
        downloader=FakeDownloader(),
        audio_extractor=FakeAudioExtractor(),
        transcriber=RecordingTranscriber(),
    )

    worker.process(job.job_id)

    failed = store.get_job(job.job_id)
    assert failed.status == "failed"
    assert failed.error == {"code": "artifact_write_failed", "message": "Could not write job artifact atomically"}
    assert failed.artifacts["transcript"] is False


def test_worker_respects_cancel_checkpoint_before_artifact_writes(tmp_path):
    store = JobStore(tmp_path)
    job = store.create_job(url="https://video.example/cancel", countries=["argentina"], extra_keywords=[])
    store.cancel_job(job.job_id)
    worker = TranscriptWorker(
        settings=Settings(api_key="test-key", runtime_dir=tmp_path),
        store=store,
        downloader=FakeDownloader(),
        audio_extractor=FakeAudioExtractor(),
        transcriber=RecordingTranscriber(),
    )

    worker.process(job.job_id)

    assert store.get_job(job.job_id).status == "cancelled"
    assert store.get_transcript(job.job_id).segments == []
