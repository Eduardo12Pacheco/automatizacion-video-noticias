from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Protocol

from .ai_rescue import AiRescueAnalysisResult, AiRescueVideoInput
from .boundary_client import BoundaryRequestError
from .opencode_go_client import OpenCodeGoError
from .radar_client import RadarBusy, RadarJobResult, RadarServerError
from .store import MonitorStore, RetentionDryRunItem, RetentionDryRunReport, SubscriptionRecord, VideoRecord
from .title_matcher import TARGET_COUNTRY_ORDER, TitleMatcher, match_program_title, normalize_country
from .youtube_client import MetadataUnavailable, SubtitleProvider, SubtitleUnavailable, UploadItem, VideoMetadata


ACTIVE_LIVE_STATUSES = {"live", "upcoming"}
TERMINAL_LIFECYCLES = {"ignored_seen", "enqueue_pending", "enqueued", "metadata_failed"}
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class ClassificationResult:
    classification_version: str
    source_country: str | None
    target_countries: list[str]
    status: str
    reason: str
    match_reason_json: str


@dataclass(frozen=True)
class ClassificationBackfillResult:
    mode: str
    classification_version: str
    candidate_count: int
    would_create_matches: int
    would_create_rejections: int
    created_or_updated_matches: int
    created_or_updated_rejections: int
    skipped_in_flight: int
    run_id: int | None = None


class ClassificationService:
    def __init__(self, *, matcher: TitleMatcher, classification_version: str):
        self.matcher = matcher
        self.classification_version = classification_version

    def classify(self, *, title: str, source_country: str | None) -> ClassificationResult:
        normalized_source = normalize_country(source_country) if source_country else None
        match = self.matcher.match(title)
        target_countries = match.target_countries(source_country=normalized_source)
        if target_countries:
            status = "approved"
            reason = "target_match"
        elif match.matched:
            status = "rejected"
            reason = "no_valid_target_match"
        else:
            status = "rejected"
            reason = "no_title_match"
        return ClassificationResult(
            classification_version=self.classification_version,
            source_country=normalized_source,
            target_countries=target_countries,
            status=status,
            reason=reason,
            match_reason_json=json.dumps(match.reasons, ensure_ascii=False),
        )


class ClassificationBackfill:
    def __init__(self, *, store: MonitorStore, classifier: ClassificationService, now: Callable[[], str] | None = None):
        self.store = store
        self.classifier = classifier
        self.now = now or _now_iso

    def run(self, *, mode: str, limit: int) -> ClassificationBackfillResult:
        if mode not in {"dry-run", "apply"}:
            raise ValueError("mode must be dry-run or apply")
        candidates = self.store.list_stale_classification_candidates(
            classification_version=self.classifier.classification_version,
            limit=limit,
        )
        results = [
            self.classifier.classify(title=candidate.video.title or "", source_country=candidate.source_country)
            for candidate in candidates
        ]
        would_create_matches = sum(len(result.target_countries) for result in results)
        would_create_rejections = sum(1 for result in results if not result.target_countries)
        if mode == "dry-run":
            return ClassificationBackfillResult(
                mode=mode,
                classification_version=self.classifier.classification_version,
                candidate_count=len(candidates),
                would_create_matches=would_create_matches,
                would_create_rejections=would_create_rejections,
                created_or_updated_matches=0,
                created_or_updated_rejections=0,
                skipped_in_flight=0,
            )
        run = self.store.create_classification_run(
            classification_version=self.classifier.classification_version,
            mode=mode,
            candidate_count=len(candidates),
            parameters_json=json.dumps({"limit": limit}, separators=(",", ":")),
        )
        created_or_updated_matches = 0
        created_or_updated_rejections = 0
        skipped_in_flight = 0
        classified_at = self.now()
        for candidate, result in zip(candidates, results):
            applied = self.store.apply_classification(
                video_id=candidate.video.video_id,
                source_country=result.source_country,
                target_countries=result.target_countries,
                status=result.status,
                reason=result.reason,
                match_reason_json=result.match_reason_json,
                classification_version=result.classification_version,
                classification_run_id=run.id,
                classified_at=classified_at,
            )
            created_or_updated_matches += applied["created_or_updated_matches"]
            created_or_updated_rejections += applied["created_or_updated_rejections"]
            skipped_in_flight += applied["skipped_in_flight"]
        self.store.finish_classification_run(
            run.id,
            status="completed",
            would_create_matches=would_create_matches,
            would_create_rejections=would_create_rejections,
            created_or_updated_matches=created_or_updated_matches,
            created_or_updated_rejections=created_or_updated_rejections,
            skipped_in_flight=skipped_in_flight,
            completed_at=classified_at,
        )
        return ClassificationBackfillResult(
            mode=mode,
            classification_version=self.classifier.classification_version,
            candidate_count=len(candidates),
            would_create_matches=would_create_matches,
            would_create_rejections=would_create_rejections,
            created_or_updated_matches=created_or_updated_matches,
            created_or_updated_rejections=created_or_updated_rejections,
            skipped_in_flight=skipped_in_flight,
            run_id=run.id,
        )


class MetadataClient(Protocol):
    def get_video_metadata(self, video_id: str) -> VideoMetadata: ...


class UploadPlaylistClient(Protocol):
    def list_upload_video_ids(self, uploads_playlist_id: str, *, limit: int) -> list[str]: ...

    def iter_upload_items(self, uploads_playlist_id: str, *, page_limit: int, item_limit: int): ...


class RadarSubmitter(Protocol):
    def submit_job(self, url: str, *, countries: list[str]) -> RadarJobResult: ...


class RadarStatusReader(Protocol):
    def get_job_detail(self, job_id: str) -> dict: ...

    def get_job_summary(self, job_id: str) -> dict: ...


class WebSubRenewer(Protocol):
    def renew(self, channel_id: str, *, lease_seconds: int = 864000) -> bool: ...


class AiRescueAnalyzerProtocol(Protocol):
    def analyze(self, video: AiRescueVideoInput) -> AiRescueAnalysisResult: ...


class TranscriptRetentionPlanner(Protocol):
    def plan_cleanup(self, *, job_ids: list[str], urls: list[str], video_ids: list[str], mode: str) -> dict[str, Any]: ...


class DiscoveryWorker:
    def __init__(
        self,
        *,
        store: MonitorStore,
        youtube: MetadataClient,
        matcher: TitleMatcher | None = None,
        classifier: ClassificationService | None = None,
        ai_rescue_enabled: bool = False,
        now: Callable[[], str] | None = None,
    ):
        self.store = store
        self.youtube = youtube
        self.ai_rescue_enabled = ai_rescue_enabled
        self.now = now or _now_iso
        if classifier is None:
            if matcher is None:
                raise ValueError("matcher or classifier is required")
            classifier = ClassificationService(matcher=matcher, classification_version="title-country-v1")
        self.classifier = classifier

    def process_video_id(self, video_id: str) -> VideoRecord:
        existing = self.store.get_video(video_id)
        if existing and existing.lifecycle in TERMINAL_LIFECYCLES:
            return existing
        try:
            metadata = self.get_video_metadata(video_id)
        except MetadataUnavailable as exc:
            failed = existing or VideoRecord(video_id=video_id, url=_video_url(video_id), lifecycle="metadata_failed")
            return self.store.upsert_video(
                failed.with_updates(lifecycle="metadata_failed", matched=False, match_reason=_metadata_unavailable_reason(exc))
            )
        except Exception as exc:
            LOGGER.exception("channel monitor item processing failed", extra={"video_id": video_id})
            return self._record_item_failure(video_id, existing=existing, error=exc)
        return self.process_video_metadata(metadata, existing=existing)

    def get_video_metadata(self, video_id: str) -> VideoMetadata:
        return self.youtube.get_video_metadata(video_id)

    def process_video_metadata(self, metadata: VideoMetadata, *, existing: VideoRecord | None = None) -> VideoRecord:
        if existing is None:
            existing = self.store.get_video(metadata.video_id)
        if existing and existing.lifecycle in TERMINAL_LIFECYCLES:
            return existing
        return self._persist_metadata(metadata, existing=existing)

    def poll_pending_live(self) -> list[VideoRecord]:
        return [self.process_video_id(video.video_id) for video in self.store.list_pending_live()]

    def _persist_metadata(self, metadata: VideoMetadata, *, existing: VideoRecord | None) -> VideoRecord:
        channel = self.store.find_channel_by_youtube_id(metadata.channel_id)
        channel_id = channel.id if channel else existing.channel_id if existing else None
        base = existing or VideoRecord(video_id=metadata.video_id, lifecycle="discovered")
        updated = base.with_updates(
            channel_id=channel_id,
            title=metadata.title,
            url=_video_url(metadata.video_id),
            published_at=metadata.published_at,
            live_status=metadata.live_status,
        )
        if metadata.live_status in ACTIVE_LIVE_STATUSES:
            return self.store.upsert_video(
                updated.with_updates(lifecycle="pending_live", matched=None, next_poll_at=_next_poll_at())
            )
        if updated.evaluated_at:
            return self.store.upsert_video(updated)
        source_country = normalize_country(channel.country) if channel else None
        important_result = _classify_important_channel(channel, title=metadata.title, live_status=metadata.live_status)
        if important_result is not None:
            now = self.now()
            return self.store.upsert_video(
                updated.with_updates(
                    lifecycle="enqueue_pending",
                    matched=True,
                    match_reason=important_result["match_reason_json"],
                    evaluated_at=now,
                    next_poll_at=None,
                    classification_version=self.classifier.classification_version,
                    classified_at=now,
                    classification_status="important",
                    classification_reason=important_result["reason"],
                    important_mode=getattr(channel, "important_mode", None),
                    important_rule_json=important_result["match_reason_json"],
                    queue_priority_tier="important",
                    queue_priority_rank=0,
                )
            )
        if channel and channel.important:
            now = self.now()
            match_reason_json = _important_channel_match_reason()
            return self.store.upsert_video(
                updated.with_updates(
                    lifecycle="enqueue_pending",
                    matched=True,
                    match_reason=match_reason_json,
                    evaluated_at=now,
                    next_poll_at=None,
                    classification_version=self.classifier.classification_version,
                    classified_at=now,
                    classification_status="important_channel",
                    classification_reason="important_channel_all_countries",
                    important_mode="legacy_important_channel",
                    important_rule_json=match_reason_json,
                    queue_priority_tier="important",
                    queue_priority_rank=0,
                )
            )
        classification = self.classifier.classify(title=metadata.title, source_country=source_country)
        accepted = bool(classification.target_countries)
        lifecycle = "enqueue_pending" if accepted else "ignored_seen"
        saved = self.store.upsert_video(
            updated.with_updates(
                lifecycle=lifecycle,
                matched=accepted,
                match_reason=classification.match_reason_json,
                evaluated_at=self.now(),
                next_poll_at=None,
                classification_version=classification.classification_version,
                classified_at=self.now(),
                classification_status=classification.status,
                classification_reason=classification.reason,
            )
        )
        if accepted:
            reasons = json.loads(classification.match_reason_json)
            for target_country in classification.target_countries:
                target_reasons = [reason for reason in reasons if reason.get("country") == target_country]
                self.store.upsert_target_match(
                    self.store.make_target_match(
                        video_id=saved.video_id,
                        target_country=target_country,
                        status="aprobado",
                        title_match_reason=json.dumps(target_reasons, ensure_ascii=False),
                    )
                )
        else:
            self.store.upsert_rejected_video(
                video_id=saved.video_id,
                source_country=source_country,
                reason=classification.reason,
                match_reason_json=classification.match_reason_json,
                classification_version=classification.classification_version,
                classified_at=saved.classified_at,
            )
            if self.ai_rescue_enabled:
                self.store.enqueue_ai_rescue_rejected_video(video_id=saved.video_id, now=self.now())
        return saved

    def _record_item_failure(self, video_id: str, *, existing: VideoRecord | None, error: Exception) -> VideoRecord:
        failed = existing or VideoRecord(video_id=video_id, url=_video_url(video_id), lifecycle="metadata_failed")
        return self.store.upsert_video(
            failed.with_updates(
                lifecycle="metadata_failed",
                matched=False,
                match_reason=f"item_processing_failed:{type(error).__name__}",
            )
        )


class CatchupWorker:
    def __init__(
        self,
        *,
        store: MonitorStore,
        youtube: UploadPlaylistClient,
        discovery: DiscoveryWorker,
        upload_limit: int = 25,
        page_limit: int | None = None,
        item_limit: int | None = None,
    ):
        self.store = store
        self.youtube = youtube
        self.discovery = discovery
        self.page_limit = page_limit if page_limit is not None else 1
        self.item_limit = item_limit if item_limit is not None else upload_limit

    def run_once(self) -> list[VideoRecord]:
        processed: list[VideoRecord] = []
        for channel in self.store.list_catchup_channels():
            if not channel.uploads_playlist_id:
                continue
            effective_since = channel.last_seen_published_at or channel.baseline_started_at
            checkpoint_candidate: str | None = None
            reached_effective_since = effective_since is None
            checkpoint_blocked = False
            non_blocking_error: str | None = None
            for item in self._iter_upload_items(channel.uploads_playlist_id):
                item_published_at = item.published_at
                metadata: VideoMetadata | None = None
                existing = self.store.get_video(item.video_id)
                if effective_since and item_published_at is None and existing is None:
                    try:
                        metadata = self.discovery.get_video_metadata(item.video_id)
                    except MetadataUnavailable:
                        checkpoint_blocked = True
                        if channel.id is not None:
                            self.store.record_channel_catchup_error(
                                channel.id,
                                error=f"metadata_unresolved:{item.video_id}",
                                caught_up_at=_now_iso(),
                            )
                        continue
                    except Exception as exc:
                        LOGGER.exception("catchup metadata resolution failed", extra={"video_id": item.video_id})
                        checkpoint_blocked = True
                        if channel.id is not None:
                            self.store.record_channel_catchup_error(
                                channel.id,
                                error=f"metadata_unresolved:{item.video_id}:{type(exc).__name__}",
                                caught_up_at=_now_iso(),
                            )
                        continue
                    item_published_at = metadata.published_at
                    if item_published_at is None:
                        checkpoint_blocked = True
                        if channel.id is not None:
                            self.store.record_channel_catchup_error(
                                channel.id,
                                error=f"metadata_missing_published_at:{item.video_id}",
                                caught_up_at=_now_iso(),
                            )
                        continue
                if effective_since and item_published_at:
                    if _iso_lt(item_published_at, effective_since):
                        reached_effective_since = True
                        break
                    if _iso_equal(item_published_at, effective_since):
                        reached_effective_since = True
                if existing is not None:
                    continue
                result = self.discovery.process_video_metadata(metadata) if metadata is not None else self.discovery.process_video_id(item.video_id)
                processed.append(result)
                if result.lifecycle == "metadata_failed":
                    non_blocking_error = f"item_failed:{item.video_id}"
                    continue
                if item_published_at and not checkpoint_blocked:
                    if checkpoint_candidate is None or _iso_gt(item_published_at, checkpoint_candidate):
                        checkpoint_candidate = item_published_at
            if channel.id is not None and checkpoint_candidate is not None and reached_effective_since and not checkpoint_blocked:
                self.store.advance_channel_catchup_checkpoint(channel.id, published_at=checkpoint_candidate, caught_up_at=_now_iso())
            if channel.id is not None and non_blocking_error is not None:
                self.store.record_channel_catchup_error(channel.id, error=non_blocking_error, caught_up_at=_now_iso())
        return processed

    def _iter_upload_items(self, uploads_playlist_id: str):
        if hasattr(self.youtube, "iter_upload_items"):
            yield from self.youtube.iter_upload_items(uploads_playlist_id, page_limit=self.page_limit, item_limit=self.item_limit)
            return
        for video_id in self.youtube.list_upload_video_ids(uploads_playlist_id, limit=self.item_limit):
            yield UploadItem(video_id=video_id, published_at=None)


class EnqueueWorker:
    def __init__(self, *, store: MonitorStore, radar: RadarSubmitter, now: Callable[[], str] | None = None):
        self.store = store
        self.radar = radar
        self.now = now or _now_iso

    def enqueue_due(self) -> list[VideoRecord]:
        now = self.now()
        results: list[VideoRecord] = []
        if self.store.has_active_transcription():
            return results
        for video in self.store.list_due_enqueue(now):
            target_matches = self.store.list_target_matches(video_id=video.video_id)
            countries = [match.target_country for match in target_matches if match.status == "aprobado"]
            if not countries:
                countries = _countries_from_match_reason(video.match_reason)
            try:
                submitted = self.radar.submit_job(video.url or _video_url(video.video_id), countries=countries)
            except RadarBusy:
                next_attempt_at = _add_minutes(now, 5)
                self.store.record_enqueue_attempt(
                    video_id=video.video_id,
                    status="busy",
                    next_attempt_at=next_attempt_at,
                    last_error="radar_busy",
                    queue_priority_tier=video.queue_priority_tier,
                    queue_priority_rank=video.queue_priority_rank,
                )
                results.append(video)
                break
            except RadarServerError as exc:
                next_attempt_at = _add_minutes(now, 5)
                self.store.record_enqueue_attempt(
                    video_id=video.video_id,
                    status="retry",
                    next_attempt_at=next_attempt_at,
                    last_error=f"radar_{exc.status_code}",
                    queue_priority_tier=video.queue_priority_tier,
                    queue_priority_rank=video.queue_priority_rank,
                )
                results.append(video)
                break
            self.store.record_enqueue_attempt(
                video_id=video.video_id,
                status="enqueued",
                radar_job_id=submitted.job_id,
                queue_priority_tier=video.queue_priority_tier or _first_queue_priority_tier(target_matches),
                queue_priority_rank=video.queue_priority_rank if video.queue_priority_rank is not None else _first_queue_priority_rank(target_matches),
            )
            self.store.update_target_matches_for_video(
                video.video_id,
                status="transcribiendo",
                radar_job_id=submitted.job_id,
            )
            results.append(self.store.upsert_video(video.with_updates(lifecycle="enqueued")))
            break
        return results


class TranscriptSyncWorker:
    def __init__(
        self,
        *,
        store: MonitorStore,
        radar: RadarStatusReader,
        enqueue_due: Callable[[], object] | None = None,
    ):
        self.store = store
        self.radar = radar
        self.enqueue_due = enqueue_due

    def sync_once(self) -> list[str]:
        synced: list[str] = []
        for pending in self.store.list_transcribing_video_jobs():
            video_id = pending["video_id"]
            job_id = pending["radar_job_id"]
            detail = self.radar.get_job_detail(job_id)
            status = str(detail.get("status", ""))
            if status == "succeeded":
                summary = self.radar.get_job_summary(job_id)
                if _is_important_video(self.store, video_id):
                    self.store.upsert_important_summary_mentions(video_id=video_id, radar_job_id=job_id, summary=summary)
                if self.store.list_target_matches(video_id=video_id):
                    self.store.update_target_matches_from_summary(
                        video_id=video_id,
                        radar_job_id=job_id,
                        summary=summary,
                    )
                else:
                    self.store.upsert_important_summary_country_matches(
                        video_id=video_id,
                        radar_job_id=job_id,
                        summary=summary,
                    )
                self.store.update_enqueue_attempt_status_by_job(
                    video_id=video_id,
                    radar_job_id=job_id,
                    status="transcrito",
                    last_error=None,
                )
                synced.append(video_id)
            elif status in {"failed", "cancelled", "deleted"}:
                error_code = _job_error_code(detail, fallback=status)
                terminal_status = "geo_blocked" if _is_geo_blocked_error(error_code) else "error"
                if self.store.list_target_matches(video_id=video_id):
                    self.store.update_target_matches_for_video(
                        video_id,
                        status=terminal_status,
                        radar_job_id=job_id,
                        last_error=error_code,
                    )
                self.store.update_enqueue_attempt_status_by_job(
                    video_id=video_id,
                    radar_job_id=job_id,
                    status=terminal_status,
                    last_error=error_code,
                )
                synced.append(video_id)
        if synced and self.enqueue_due is not None:
            self.enqueue_due()
        return synced


class AiRescueWorker:
    def __init__(
        self,
        *,
        store: MonitorStore,
        subtitles: SubtitleProvider,
        analyzer: AiRescueAnalyzerProtocol,
        enabled: bool,
        now: Callable[[], str] | None = None,
        retry_attempts: int = 3,
        retry_interval_seconds: int = 7200,
        processing_timeout_seconds: int = 1800,
        default_language: str = "en",
    ):
        self.store = store
        self.subtitles = subtitles
        self.analyzer = analyzer
        self.enabled = enabled
        self.now = now or _now_iso
        self.retry_attempts = retry_attempts
        self.retry_interval_seconds = retry_interval_seconds
        self.processing_timeout_seconds = processing_timeout_seconds
        self.default_language = default_language

    def drain_due(self) -> list[str]:
        if not self.enabled:
            return []
        now = self.now()
        self.store.reap_stale_ai_rescue_processing(now=now, stale_after_seconds=self.processing_timeout_seconds)
        queue_item = self.store.claim_next_ai_rescue_queue_item(now=now)
        if queue_item is None:
            return []
        video = self.store.get_video(queue_item.video_id)
        try:
            segments = self.subtitles.fetch(
                video_id=queue_item.video_id,
                source_language=queue_item.source_country,
                default_language=self.default_language,
            )
        except SubtitleUnavailable as exc:
            self._handle_missing_subtitles(queue_item.id, now=now, error=str(exc), details=exc.details)
            return [queue_item.video_id]
        try:
            analysis = self.analyzer.analyze(
                AiRescueVideoInput(
                    video_id=queue_item.video_id,
                    title=video.title if video else None,
                    source_country=queue_item.source_country,
                    source_language=segments[0].language if segments else None,
                    segments=segments,
                )
            )
        except Exception as exc:
            self._handle_analysis_failure(queue_item.id, now=now, reason=_ai_rescue_error_code(exc))
            return [queue_item.video_id]
        for candidate in analysis.candidates:
            self.store.store_ai_rescue_candidate(
                queue_id=queue_item.id,
                video_id=queue_item.video_id,
                target_country=candidate.target_country,
                score=candidate.score,
                summary_es=candidate.summary_es,
                angle_es=candidate.angle_es,
                risk=candidate.risk,
                risks_json=json.dumps(candidate.risks, ensure_ascii=False),
                evidence=[evidence.__dict__ for evidence in candidate.evidence],
                raw_response_json=analysis.raw_response_json,
            )
        for rejection in analysis.rejections:
            self.store.store_ai_rescue_rejection(
                queue_id=queue_item.id,
                video_id=queue_item.video_id,
                target_country=rejection.target_country,
                source="ai",
                reason=rejection.reason,
                details_json=json.dumps({"explanation_es": rejection.explanation_es}, ensure_ascii=False),
            )
        if not analysis.candidates:
            self.store.reject_ai_rescue_queue_item(
                queue_item.id,
                now=now,
                source="ai",
                reason="no-candidates",
                details_json=analysis.raw_response_json,
            )
        return [queue_item.video_id]

    def _handle_missing_subtitles(
        self, queue_id: int, *, now: str, error: str, details: dict[str, object] | None = None
    ) -> None:
        item = self.store.get_ai_rescue_queue_item(queue_id)
        if item is None:
            raise KeyError(queue_id)
        if item.attempt_count + 1 >= self.retry_attempts:
            self.store.reject_ai_rescue_queue_item(
                queue_id,
                now=now,
                source="system",
                reason="no-subtitles",
                details_json=json.dumps(
                    {"error": error, "subtitle_error": details or {}}, ensure_ascii=False, separators=(",", ":")
                ),
                increment_attempt=True,
            )
            return
        self.store.schedule_ai_rescue_retry(
            queue_id,
            now=now,
            next_attempt_at=_add_seconds(now, self.retry_interval_seconds),
            last_error="no-subtitles",
        )

    def _handle_analysis_failure(self, queue_id: int, *, now: str, reason: str) -> None:
        item = self.store.get_ai_rescue_queue_item(queue_id)
        if item is None:
            raise KeyError(queue_id)
        if item.attempt_count + 1 >= self.retry_attempts:
            self.store.reject_ai_rescue_queue_item(
                queue_id,
                now=now,
                source="system",
                reason=reason,
                details_json=json.dumps({"error": reason}, ensure_ascii=False, separators=(",", ":")),
                increment_attempt=True,
            )
            return
        self.store.schedule_ai_rescue_retry(
            queue_id,
            now=now,
            next_attempt_at=_add_seconds(now, self.retry_interval_seconds),
            last_error=reason,
        )


class CleanupWorker:
    def __init__(
        self,
        *,
        store: MonitorStore,
        now: Callable[[], str] | None = None,
        retention_hours: int = 120,
        mode: str = "dry-run",
        transcript: TranscriptRetentionPlanner | None = None,
    ):
        self.store = store
        self.now = now or _now_iso
        self.retention_hours = retention_hours
        self.mode = mode
        self.transcript = transcript

    def cleanup_old_rows(self):
        return self.run_retention_cleanup()

    def run_retention_cleanup(self) -> RetentionDryRunReport:
        if self.mode not in {"dry-run", "apply"}:
            raise ValueError("mode must be dry-run or apply")
        started_at = self.now()
        cutoff = _add_minutes(started_at, -self.retention_hours * 60)
        report = self.store.build_retention_dry_run_report(cutoff=cutoff)
        if self.mode == "dry-run" and self.transcript is None:
            return report
        if self.mode == "dry-run":
            enriched_items = [self._with_transcript_plan(item, mode="dry-run") for item in report.items]
            return RetentionDryRunReport(mode=report.mode, cutoff=report.cutoff, items=enriched_items)
        if self.transcript is None and report.items:
            raise ValueError("apply cleanup requires a transcript cleanup client")
        applied_items: list[RetentionDryRunItem] = []
        deleted_count = 0
        errors: list[dict[str, Any]] = []
        for item in report.items:
            transcript_result = self._transcript_cleanup_result(item, mode="apply")
            blockers = [*transcript_result.get("skipped_active", []), *transcript_result.get("errors", [])]
            if blockers:
                errors.append({"video_id": item.video_id, "skipped_active": transcript_result.get("skipped_active", []), "errors": transcript_result.get("errors", [])})
                applied_items.append(self._item_with_transcript_result(item, transcript_result))
                continue
            channel_counts = self.store.delete_detected_video_state(item.video_id)
            deleted_count += channel_counts["videos"]
            applied_items.append(self._item_with_transcript_result(item, transcript_result, planned_deletions=channel_counts))
        self.store.record_cleanup_run(
            started_at=started_at,
            deleted_count=deleted_count,
            error=json.dumps(errors, ensure_ascii=False, separators=(",", ":")) if errors else None,
        )
        return RetentionDryRunReport(mode="apply", cutoff=report.cutoff, items=applied_items)

    def _with_transcript_plan(self, item: RetentionDryRunItem, *, mode: str) -> RetentionDryRunItem:
        result = self._transcript_cleanup_result(item, mode=mode)
        planned = result.get("planned", [])
        artifacts = [artifact for artifact in planned if isinstance(artifact, dict)]
        counts = item.planned_deletions | {"transcript_artifacts": len(artifacts)}
        return RetentionDryRunItem(
            video_id=item.video_id,
            url=item.url,
            detected_at=item.detected_at,
            lifecycle=item.lifecycle,
            states=item.states,
            transcript_refs=item.transcript_refs,
            planned_deletions=counts,
            transcript_artifacts=artifacts,
        )

    def _transcript_cleanup_result(self, item: RetentionDryRunItem, *, mode: str) -> dict[str, Any]:
        if self.transcript is None:
            return {"planned": [], "deleted": [], "missing": [], "skipped_active": [], "errors": []}
        return self.transcript.plan_cleanup(
            job_ids=item.transcript_refs["radar_job_ids"],
            urls=item.transcript_refs["urls"],
            video_ids=item.transcript_refs["video_ids"],
            mode=mode,
        )

    def _item_with_transcript_result(
        self,
        item: RetentionDryRunItem,
        result: dict[str, Any],
        *,
        planned_deletions: dict[str, int] | None = None,
    ) -> RetentionDryRunItem:
        artifacts = [artifact for artifact in result.get("deleted", []) if isinstance(artifact, dict)]
        artifacts.extend({"kind": "missing", "value": value} for value in result.get("missing", []))
        artifacts.extend({"kind": "skipped_active", "job_id": value} for value in result.get("skipped_active", []))
        artifacts.extend({"kind": "error", "error": error} for error in result.get("errors", []))
        counts = (planned_deletions or item.planned_deletions) | {"transcript_artifacts": len(artifacts)}
        return RetentionDryRunItem(
            video_id=item.video_id,
            url=item.url,
            detected_at=item.detected_at,
            lifecycle=item.lifecycle,
            states=item.states,
            transcript_refs=item.transcript_refs,
            planned_deletions=counts,
            transcript_artifacts=artifacts,
        )


class WebSubRenewalWorker:
    def __init__(
        self,
        *,
        store: MonitorStore,
        websub: WebSubRenewer,
        callback_url: str,
        now: Callable[[], str] | None = None,
        lease_seconds: int = 864000,
    ):
        self.store = store
        self.websub = websub
        self.callback_url = callback_url
        self.now = now or _now_iso
        self.lease_seconds = lease_seconds

    def renew_all(self) -> list[SubscriptionRecord]:
        renewed_at = self.now()
        expires_at = _add_minutes(renewed_at, self.lease_seconds // 60)
        results: list[SubscriptionRecord] = []
        for channel in self.store.list_channels():
            if not channel.enabled:
                continue
            last_error = None
            try:
                accepted = self.websub.renew(channel.youtube_channel_id, lease_seconds=self.lease_seconds)
            except BoundaryRequestError as exc:
                accepted = False
                last_error = exc.code
            results.append(
                self.store.record_subscription(
                    channel_id=channel.id,
                    callback_url=self.callback_url,
                    lease_seconds=self.lease_seconds,
                    expires_at=expires_at if accepted else None,
                    last_renewed_at=renewed_at,
                    status="ready" if accepted else "failed",
                    last_error=None if accepted else (last_error or "websub_renewal_rejected"),
                )
            )
        return results


def _video_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _metadata_unavailable_reason(error: MetadataUnavailable) -> str:
    return str(getattr(error, "reason", "") or "metadata_unavailable")


def _next_poll_at() -> str:
    return (datetime.now(UTC) + timedelta(minutes=15)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _add_minutes(value: str, minutes: int) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parsed + timedelta(minutes=minutes)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _add_seconds(value: str, seconds: int) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parsed + timedelta(seconds=seconds)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso_lte(left: str, right: str) -> bool:
    return _parse_iso(left) <= _parse_iso(right)


def _iso_lt(left: str, right: str) -> bool:
    return _parse_iso(left) < _parse_iso(right)


def _iso_equal(left: str, right: str) -> bool:
    return _parse_iso(left) == _parse_iso(right)


def _iso_gt(left: str, right: str) -> bool:
    return _parse_iso(left) > _parse_iso(right)


def _countries_from_match_reason(match_reason: str | None) -> list[str]:
    if not match_reason:
        return []
    try:
        reasons = json.loads(match_reason)
    except json.JSONDecodeError:
        return []
    countries: list[str] = []
    for reason in reasons:
        country = str(reason.get("country", "")).strip().casefold()
        if country and country not in countries:
            countries.append(country)
    if countries:
        return countries
    for reason in reasons:
        source_country = str(reason.get("source_country", "")).strip().casefold()
        if source_country and source_country not in countries:
            countries.append(source_country)
    return countries


def _important_channel_match_reason() -> str:
    return json.dumps(
        [{"type": "important_channel", "country": country} for country in TARGET_COUNTRY_ORDER],
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _classify_important_channel(channel: Any, *, title: str, live_status: str | None) -> dict[str, str] | None:
    mode = str(getattr(channel, "important_mode", "") or "").strip()
    if mode == "full_channel":
        return {
            "reason": "important_full_channel",
            "match_reason_json": json.dumps(
                [
                    {
                        "type": "important_full_channel",
                        "label": getattr(channel, "label", None),
                        "source_country": normalize_country(getattr(channel, "country", None)),
                    }
                ],
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        }
    if mode != "program_rules":
        return None
    content_type = _important_content_type(live_status)
    for rule in getattr(channel, "important_rules", []) or []:
        if not _important_rule_allows_content_type(rule, content_type):
            continue
        match = match_program_title(title, rule)
        if match is None:
            continue
        return {
            "reason": "important_program_rule",
            "match_reason_json": json.dumps(
                [
                    {
                        "type": "important_program_rule",
                        "label": getattr(channel, "label", None),
                        "source_country": normalize_country(getattr(channel, "country", None)),
                        "op": match.op,
                        "value": match.value,
                        "normalized_value": match.normalized_value,
                        "normalized_title": match.normalized_title,
                    }
                ],
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        }
    return None


def _important_content_type(live_status: str | None) -> str:
    return "completed" if str(live_status or "").strip().casefold() not in ACTIVE_LIVE_STATUSES else "live"


def _important_rule_allows_content_type(rule: Any, content_type: str) -> bool:
    content_types = [str(item).strip().casefold() for item in getattr(rule, "content_types", []) or []]
    return not content_types or content_type in content_types


def _is_important_video(store: MonitorStore, video_id: str) -> bool:
    video = store.get_video(video_id)
    if video is None:
        return False
    if video.important_mode or video.queue_priority_tier == "important" or video.classification_status in {"important", "important_channel"}:
        return True
    if video.channel_id is None:
        return False
    channel = store.find_channel_by_id(video.channel_id)
    return bool(channel and channel.important)


def _first_queue_priority_tier(target_matches: list[Any]) -> str | None:
    for match in target_matches:
        if match.status == "aprobado" and match.queue_priority_tier:
            return match.queue_priority_tier
    return None


def _first_queue_priority_rank(target_matches: list[Any]) -> int | None:
    for match in target_matches:
        if match.status == "aprobado" and match.queue_priority_rank is not None:
            return match.queue_priority_rank
    return None


def _normalized_mention_counts_json(summary: dict) -> str:
    items: list[dict[str, object]] = []
    for raw_item in summary.get("items", []):
        label = str(raw_item.get("label", "")).strip()
        try:
            count = int(raw_item.get("count", 0))
        except (TypeError, ValueError):
            count = 0
        if not label or count <= 0:
            continue
        item: dict[str, object] = {"label": label, "count": count}
        timestamps = raw_item.get("timestamps")
        if timestamps:
            item["timestamps"] = timestamps
        items.append(item)
    return json.dumps(items, ensure_ascii=False, separators=(",", ":"))


def _job_error_code(detail: dict, *, fallback: str) -> str:
    error = detail.get("error")
    if isinstance(error, dict):
        message = str(error.get("message", "")).strip()
        code = str(error.get("code", "")).strip()
        classified = _classify_provider_error(code or message)
        if classified:
            return classified
        classified = _classify_provider_error(message)
        if classified:
            return classified
        if code:
            return code
    if isinstance(error, str):
        classified = _classify_provider_error(error)
        if classified:
            return classified
    return fallback


def _classify_provider_error(value: str) -> str | None:
    normalized = str(value or "").casefold().replace("-", "_")
    if _is_geo_blocked_error(value):
        return "yt_dlp_geo_blocked"
    if "yt_dlp_live_pending" in normalized or "live event will begin" in normalized or "not started" in normalized or "upcoming" in normalized:
        return "yt_dlp_live_pending"
    if "yt_dlp_copyright_blocked" in normalized or "copyright" in normalized or "contains content from" in normalized:
        return "yt_dlp_copyright_blocked"
    if "yt_dlp_private_or_removed" in normalized or "video unavailable" in normalized or "private" in normalized or "removed by" in normalized:
        return "yt_dlp_private_or_removed"
    if "yt_dlp_age_restricted" in normalized or "confirm your age" in normalized or "age_restricted" in normalized or "age restricted" in normalized:
        return "yt_dlp_age_restricted"
    if "yt_dlp_bot_check" in normalized or "not a bot" in normalized or "sign in to confirm" in normalized:
        return "yt_dlp_bot_check"
    if "yt_dlp_timeout" in normalized or "timed out" in normalized or "timeout" in normalized:
        return "yt_dlp_timeout"
    return None


def _is_geo_blocked_error(value: str) -> bool:
    normalized = str(value or "").casefold()
    return (
        "geo_blocked" in normalized
        or "yt_dlp_geo_blocked" in normalized
        or "not available in your country" in normalized
        or "not made this video available in your country" in normalized
        or "geo-restricted" in normalized
        or "geo restricted" in normalized
    )


def _ai_rescue_error_code(error: Exception) -> str:
    if isinstance(error, OpenCodeGoError):
        if error.category in {"rate_limited", "server_error", "timeout", "transport", "auth"}:
            return f"opencode_{error.category}"
        return "opencode_error"
    return "analysis_error"


def accepts_foreign_press_match(reasons: list[dict[str, str]], *, source_country: str | None) -> bool:
    if not reasons:
        return False
    normalized_source = normalize_country(source_country)
    if not normalized_source:
        return True
    for reason in reasons:
        country = normalize_country(reason.get("country"))
        if country and country != normalized_source:
            return True
    return False
