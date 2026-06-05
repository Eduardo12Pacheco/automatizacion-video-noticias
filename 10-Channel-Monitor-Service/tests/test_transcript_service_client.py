from __future__ import annotations

import pytest

from app.radar_client import RadarBusy, RadarJobResult
from app.transcript_service_client import TranscriptServiceSubtitleProvider
from app.youtube_client import SubtitleSegment, SubtitleUnavailable


class FakeTranscriptRadar:
    def __init__(self, *, detail_sequence: list[dict] | None = None, transcript: dict | None = None, busy: bool = False):
        self.detail_sequence = detail_sequence or [{"status": "succeeded"}]
        self.transcript = transcript or {"detected_language": "es", "segments": [{"start_ms": 0, "end_ms": 1200, "text": "Gol de Ecuador"}]}
        self.busy = busy
        self.calls: list[tuple[str, object]] = []

    def submit_job(self, url: str, *, countries: list[str]):
        self.calls.append(("submit", {"url": url, "countries": countries}))
        if self.busy:
            raise RadarBusy("radar_busy")
        return RadarJobResult(job_id="job-1", status="queued")

    def get_job_detail(self, job_id: str):
        self.calls.append(("detail", job_id))
        if len(self.detail_sequence) == 1:
            return self.detail_sequence[0]
        return self.detail_sequence.pop(0)

    def get_job_transcript(self, job_id: str):
        self.calls.append(("transcript", job_id))
        return self.transcript


def test_transcript_service_subtitle_provider_submits_youtube_url_and_maps_segments():
    radar = FakeTranscriptRadar()
    provider = TranscriptServiceSubtitleProvider(radar=radar, poll_interval_seconds=0, sleeper=lambda _seconds: None)

    segments = provider.fetch(video_id="vid-1", source_language="colombia", default_language="en")

    assert segments == [SubtitleSegment(start_ms=0, end_ms=1200, text="Gol de Ecuador", language="es")]
    assert radar.calls == [
        ("submit", {"url": "https://www.youtube.com/watch?v=vid-1", "countries": ["colombia"]}),
        ("detail", "job-1"),
        ("transcript", "job-1"),
    ]


def test_transcript_service_subtitle_provider_fails_closed_on_busy_service():
    provider = TranscriptServiceSubtitleProvider(radar=FakeTranscriptRadar(busy=True), sleeper=lambda _seconds: None)

    with pytest.raises(SubtitleUnavailable) as exc:
        provider.fetch(video_id="busy", source_language="argentina", default_language="en")

    assert exc.value.reason == "transcript_service_busy"
    assert exc.value.details == {"provider": "transcript-service", "reason": "transcript_service_busy", "video_id": "busy"}


def test_transcript_service_subtitle_provider_does_not_return_empty_transcripts():
    provider = TranscriptServiceSubtitleProvider(
        radar=FakeTranscriptRadar(transcript={"detected_language": "es", "segments": []}),
        sleeper=lambda _seconds: None,
    )

    with pytest.raises(SubtitleUnavailable) as exc:
        provider.fetch(video_id="empty", source_language="ecuador", default_language="en")

    assert exc.value.reason == "empty_transcript"
