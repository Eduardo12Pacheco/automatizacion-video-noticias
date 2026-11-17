from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Protocol

from .radar_client import RadarBusy, RadarJobResult, RadarServerError
from .store import MonitorStore, RetentionDryRunItem, RetentionDryRunReport, VideoRecord
from .title_matcher import TARGET_COUNTRY_ORDER, TitleMatcher, match_program_title, normalize_country
from .time_utils import add_minutes, add_seconds, iso_equal, iso_gt, iso_lt, iso_lte, now_iso, parse_iso
from .video_urls import video_watch_url
from .retention import CleanupWorker
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
        self.now = now or now_iso

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


class DiscoveryWorker:
    def __init__(
        self,
        *,
        store: MonitorStore,
        youtube: MetadataClient,
        matcher: TitleMatcher | None = None,
        classifier: ClassificationService | None = None,
        now: Callable[[], str] | None = None,
    ):
        self.store = store
        self.youtube = youtube
        self.now = now or now_iso
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
            failed = existing or VideoRecord(video_id=video_id, url=video_watch_url(video_id), lifecycle="metadata_failed")
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
            url=video_watch_url(metadata.video_id),
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
        return saved

    def _record_item_failure(self, video_id: str, *, existing: VideoRecord | None, error: Exception) -> VideoRecord:
        failed = existing or VideoRecord(video_id=video_id, url=video_watch_url(video_id), lifecycle="metadata_failed")
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
                                caught_up_at=now_iso(),
                            )
                        continue
                    except Exception as exc:
                        LOGGER.exception("catchup metadata resolution failed", extra={"video_id": item.video_id})
                        checkpoint_blocked = True
                        if channel.id is not None:
                            self.store.record_channel_catchup_error(
                                channel.id,
                                error=f"metadata_unresolved:{item.video_id}:{type(exc).__name__}",
                                caught_up_at=now_iso(),
                            )
                        continue
                    item_published_at = metadata.published_at
                    if item_published_at is None:
                        checkpoint_blocked = True
                        if channel.id is not None:
                            self.store.record_channel_catchup_error(
                                channel.id,
                                error=f"metadata_missing_published_at:{item.video_id}",
                                caught_up_at=now_iso(),
                            )
                        continue
                if effective_since and item_published_at:
                    if iso_lt(item_published_at, effective_since):
                        reached_effective_since = True
                        break
                    if iso_equal(item_published_at, effective_since):
                        reached_effective_since = True
                if existing is not None:
                    continue
                result = self.discovery.process_video_metadata(metadata) if metadata is not None else self.discovery.process_video_id(item.video_id)
                processed.append(result)
                if result.lifecycle == "metadata_failed":
                    non_blocking_error = f"item_failed:{item.video_id}"
                    continue
                if item_published_at and not checkpoint_blocked:
                    if checkpoint_candidate is None or iso_gt(item_published_at, checkpoint_candidate):
                        checkpoint_candidate = item_published_at
            if channel.id is not None and checkpoint_candidate is not None and reached_effective_since and not checkpoint_blocked:
                self.store.advance_channel_catchup_checkpoint(channel.id, published_at=checkpoint_candidate, caught_up_at=now_iso())
            if channel.id is not None and non_blocking_error is not None:
                self.store.record_channel_catchup_error(channel.id, error=non_blocking_error, caught_up_at=now_iso())
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
        self.now = now or now_iso

    def enqueue_due(self) -> list[VideoRecord]:
        now = self.now()
        results: list[VideoRecord] = []
        if self.store.has_active_transcription():
            return results
        for video in self.store.list_due_enqueue(now):
            target_matches = self.store.list_target_matches(video_id=video.video_id)
            countries = _submission_countries_for_video(video, target_matches)
            try:
                submitted = self.radar.submit_job(video.url or video_watch_url(video.video_id), countries=countries)
            except RadarBusy:
                next_attempt_at = add_minutes(now, 5)
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
                next_attempt_at = add_minutes(now, 5)
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


def _metadata_unavailable_reason(error: MetadataUnavailable) -> str:
    return str(getattr(error, "reason", "") or "metadata_unavailable")


def _next_poll_at() -> str:
    return add_minutes(now_iso(), 15)


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


def _submission_countries_for_video(video: VideoRecord, target_matches: list[Any]) -> list[str]:
    countries = [match.target_country for match in target_matches if match.status == "aprobado"]
    if countries:
        return countries
    if _submits_to_all_target_countries(video):
        return list(TARGET_COUNTRY_ORDER)
    return _countries_from_match_reason(video.match_reason)


def _submits_to_all_target_countries(video: VideoRecord) -> bool:
    if video.queue_priority_tier == "important":
        return True
    if video.important_mode in {"full_channel", "program_rules", "legacy_important_channel"}:
        return True
    if video.classification_status in {"important", "important_channel"}:
        return True
    return False


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
