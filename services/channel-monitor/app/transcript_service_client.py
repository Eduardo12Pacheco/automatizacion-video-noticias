from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Protocol

from .radar_client import RadarBusy, RadarJobResult, RadarServerError
from .youtube_client import SubtitleSegment, SubtitleUnavailable
from .video_urls import video_watch_url


class TranscriptServiceClient(Protocol):
    def submit_job(self, url: str, *, countries: list[str]) -> RadarJobResult: ...

    def get_job_detail(self, job_id: str) -> dict: ...

    def get_job_transcript(self, job_id: str) -> dict: ...


@dataclass(frozen=True)
class TranscriptServiceSubtitleProvider:
    radar: TranscriptServiceClient
    timeout_seconds: int = 900
    poll_interval_seconds: float = 5.0
    clock: Callable[[], float] = time.monotonic
    sleeper: Callable[[float], None] = time.sleep

    provider_name = "transcript-service"

    def fetch(self, *, video_id: str, source_language: str | None, default_language: str) -> list[SubtitleSegment]:
        countries = [str(source_language or default_language or "en").strip().casefold() or "en"]
        try:
            submitted = self.radar.submit_job(video_watch_url(video_id), countries=countries)
            detail = self._wait_for_completion(submitted.job_id)
            if str(detail.get("status") or "").casefold() != "succeeded":
                raise self._unavailable(video_id, default_language, reason="transcript_service_failed", detail=detail)
            transcript = self.radar.get_job_transcript(submitted.job_id)
        except SubtitleUnavailable:
            raise
        except RadarBusy as exc:
            raise self._unavailable(video_id, default_language, reason="transcript_service_busy") from exc
        except RadarServerError as exc:
            raise self._unavailable(video_id, default_language, reason="transcript_service_unavailable") from exc
        except Exception as exc:
            raise self._unavailable(video_id, default_language, reason="transcript_service_error") from exc

        language = str(transcript.get("detected_language") or default_language or "en").strip() or "en"
        segments = [_segment_from_transcript(item, language=language) for item in transcript.get("segments") or []]
        segments = [segment for segment in segments if segment is not None]
        if not segments:
            raise self._unavailable(video_id, language, reason="empty_transcript")
        return segments

    def _wait_for_completion(self, job_id: str) -> dict:
        deadline = self.clock() + max(0, int(self.timeout_seconds))
        while True:
            detail = self.radar.get_job_detail(job_id)
            status = str(detail.get("status") or "").casefold()
            if status in {"succeeded", "failed", "cancelled", "deleted"}:
                return detail
            if self.clock() >= deadline:
                return {**detail, "status": "failed", "error": {"code": "transcript_service_timeout"}}
            self.sleeper(max(0.0, float(self.poll_interval_seconds)))

    def _unavailable(self, video_id: str, language: str | None, *, reason: str, detail: dict | None = None) -> SubtitleUnavailable:
        details = {"provider": self.provider_name, "reason": reason, "video_id": video_id}
        if detail:
            error = detail.get("error") if isinstance(detail.get("error"), dict) else {}
            if error.get("code"):
                details["error_code"] = str(error.get("code"))
        return SubtitleUnavailable(video_id, language or "en", reason=reason, details=details)




def _segment_from_transcript(item: object, *, language: str) -> SubtitleSegment | None:
    if not isinstance(item, dict):
        return None
    text = str(item.get("text") or "").strip()
    if not text:
        return None
    try:
        start_ms = int(item.get("start_ms") or 0)
        end_ms = int(item.get("end_ms") or 0)
    except (TypeError, ValueError):
        return None
    if end_ms <= start_ms:
        return None
    return SubtitleSegment(start_ms=start_ms, end_ms=end_ms, text=text, language=language)
