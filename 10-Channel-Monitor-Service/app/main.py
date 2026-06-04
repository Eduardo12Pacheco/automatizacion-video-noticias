from __future__ import annotations

import secrets
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from .ai_rescue import AiRescueAnalyzer, SubtitlePayloadPolicy
from .channel_bootstrap import ChannelResolver, channel_sync_report_to_dict, sync_configured_channels
from .opencode_go_client import OpenCodeGoClient
from .radar_client import RadarClient
from .runtime import RuntimeCoordinator, RuntimeLoop
from .settings import Settings, load_and_validate_channel_config, load_settings, validation_report_to_dict
from .store import ChannelRecord, MonitorCardRecord, MonitorStore
from .title_matcher import TARGET_COUNTRY_ORDER, TitleMatcher, load_title_catalog, normalize_country
from .workers import AiRescueWorker, ClassificationService, CatchupWorker, CleanupWorker, DiscoveryWorker, EnqueueWorker, TranscriptSyncWorker, WebSubRenewalWorker
from .youtube_client import CallbackValidationError, CompositeSubtitleProvider, WebSubClient, YouTubeDataClient, YouTubeTranscriptSubtitleProvider, YtDlpSubtitleProvider, parse_websub_video_ids, validate_websub_callback


def _error(code: str, message: str, status_code: int) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _authorize(settings: Settings, api_key: str | None) -> None:
    if not settings.api_key:
        raise _error("missing_api_key_config", "Channel monitor API key is not configured", 500)
    if not api_key or not secrets.compare_digest(api_key, settings.api_key):
        raise _error("unauthorized", "Invalid or missing API key", 401)


def _require_ai_rescue_enabled(settings: Settings) -> None:
    if not settings.ai_rescue_enabled:
        raise _error("ai_rescue_disabled", "AI Rescue is disabled", 403)


def create_app(
    *,
    settings: Settings | None = None,
    store: MonitorStore | None = None,
    discovery_worker: Any | None = None,
    channel_resolver: ChannelResolver | None = None,
    radar_client: Any | None = None,
    runtime_coordinator: Any | None = None,
) -> FastAPI:
    settings = settings or load_settings()
    store = store or MonitorStore(settings.db_path)
    store.migrate()

    radar_client = radar_client or RadarClient(base_url=settings.radar_url, api_key=settings.radar_api_key)
    channel_resolver = channel_resolver or _build_channel_resolver(settings=settings)
    discovery_worker = discovery_worker or _build_discovery_worker(settings=settings, store=store)
    runtime_coordinator = runtime_coordinator or _build_runtime_coordinator(
        settings=settings,
        store=store,
        discovery_worker=discovery_worker,
        radar_client=radar_client,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.runtime_coordinator = runtime_coordinator
        _sync_channels_for_preflight_or_startup(settings=settings, store=store, channel_resolver=channel_resolver)
        await runtime_coordinator.start()
        try:
            yield
        finally:
            await runtime_coordinator.stop()

    app = FastAPI(title="radar-channel-monitor", version="0.1.0", lifespan=lifespan)

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        public_paths = {"/api/monitor/live", "/api/monitor/websub"}
        if request.url.path.startswith("/api/monitor/") and request.url.path not in public_paths:
            try:
                _authorize(settings, request.headers.get("x-api-key"))
            except HTTPException as exc:
                return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        return await call_next(request)

    @app.get("/api/monitor/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/monitor/health")
    async def health() -> dict[str, Any]:
        return _preflight_response(
            settings=settings,
            store=store,
            channel_resolver=channel_resolver,
            radar_client=radar_client,
            runtime_coordinator=runtime_coordinator,
        )

    @app.get("/api/monitor/preflight")
    async def preflight() -> dict[str, Any]:
        return _preflight_response(
            settings=settings,
            store=store,
            channel_resolver=channel_resolver,
            radar_client=radar_client,
            runtime_coordinator=runtime_coordinator,
        )

    @app.get("/api/monitor/cleanup/dry-run")
    async def cleanup_dry_run(now: str | None = None, limit: int = 200) -> dict[str, Any]:
        worker = CleanupWorker(
            store=store,
            now=(lambda: now) if now else _utc_now_iso,
            retention_hours=settings.cleanup_retention_hours,
            mode="dry-run",
        )
        report = worker.run_retention_cleanup()
        if limit != 200:
            report = report.__class__(mode=report.mode, cutoff=report.cutoff, items=report.items[: max(1, min(int(limit), 1000))])
        return _retention_report_to_dict(report)

    @app.get("/api/monitor/ai-rescue/preflight")
    async def ai_rescue_preflight() -> dict[str, Any]:
        return _ai_rescue_preflight_response(
            settings=settings,
            store=store,
            runtime_coordinator=runtime_coordinator,
        )

    @app.get("/api/monitor/ai-rescue/queue")
    async def ai_rescue_queue() -> dict[str, Any]:
        _require_ai_rescue_enabled(settings)
        snapshot = store.ai_rescue_queue_snapshot(now=_utc_now_iso(), upcoming_limit=10)
        return {
            "current": _ai_rescue_queue_to_dict(snapshot["current"]),
            "upcoming": [_ai_rescue_queue_to_dict(item) for item in snapshot["upcoming"]],
            "counts": snapshot["counts"],
        }

    @app.get("/api/monitor/ai-rescue/candidates")
    async def ai_rescue_candidates(target_country: str | None = None) -> dict[str, Any]:
        _require_ai_rescue_enabled(settings)
        target = normalize_country(target_country) if target_country else None
        now = _utc_now_iso()
        candidates = [candidate for candidate in store.list_ai_rescue_candidates(now=now) if target is None or candidate.target_country == target]
        rejections = store.list_ai_rescue_rejections(now=now)
        return {
            "summary": _ai_rescue_summary(candidates=candidates, rejection_count=len(rejections)),
            "items": [_ai_rescue_candidate_to_dict(store, candidate, include_evidence=False) for candidate in candidates],
        }

    @app.get("/api/monitor/ai-rescue/candidates/{candidate_id}")
    async def ai_rescue_candidate_detail(candidate_id: int) -> dict[str, Any]:
        _require_ai_rescue_enabled(settings)
        candidate = store.get_ai_rescue_candidate(candidate_id)
        if candidate is None:
            raise _error("candidate_not_found", f"AI Rescue candidate {candidate_id} was not found", 404)
        return _ai_rescue_candidate_to_dict(store, candidate, include_evidence=True)

    @app.get("/api/monitor/ai-rescue/rejections")
    async def ai_rescue_rejections() -> dict[str, Any]:
        _require_ai_rescue_enabled(settings)
        return {"items": [_ai_rescue_rejection_to_dict(rejection) for rejection in store.list_ai_rescue_rejections(now=_utc_now_iso())]}

    @app.post("/api/monitor/ai-rescue/refresh")
    async def ai_rescue_refresh() -> dict[str, Any]:
        if not settings.ai_rescue_enabled:
            return {"status": "disabled", "enqueued_count": 0}
        enqueued_count = 0
        existing = {item.video_id for item in store.list_ai_rescue_queue(limit=200)}
        for item in store.list_rejected_videos(limit=200, offset=0, now=_utc_now_iso()).items:
            if item.video_id not in existing:
                store.enqueue_ai_rescue_rejected_video(video_id=item.video_id, now=_utc_now_iso())
                enqueued_count += 1
        return {"status": "ok", "enqueued_count": enqueued_count}

    @app.post("/api/monitor/ai-rescue/candidates/{candidate_id}/approve")
    async def ai_rescue_approve_candidate(candidate_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        _require_ai_rescue_enabled(settings)
        _require_confirmation(payload)
        try:
            promoted = store.promote_ai_rescue_candidate(
                candidate_id,
                allowed_target_countries=list(TARGET_COUNTRY_ORDER),
            )
        except KeyError as exc:
            raise _error("candidate_not_found", f"AI Rescue candidate {candidate_id} was not found", 404) from exc
        except ValueError as exc:
            raise _error(str(exc), "AI Rescue candidate cannot be promoted", 400) from exc
        store.mark_ai_rescue_candidate_approved(
            candidate_id,
            reviewer=_optional_text(payload.get("reviewer")),
            decided_at=_utc_now_iso(),
        )
        return {"status": "approved", "promoted": _promoted_match_to_dict(promoted)}

    @app.post("/api/monitor/ai-rescue/candidates/{candidate_id}/reject")
    async def ai_rescue_reject_candidate(candidate_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        _require_ai_rescue_enabled(settings)
        _require_confirmation(payload)
        reason = _optional_text(payload.get("reason"))
        if reason is None:
            raise _error("missing_reason", "Human rejection reason is required", 400)
        try:
            decision = store.mark_ai_rescue_candidate_rejected(
                candidate_id,
                reviewer=_optional_text(payload.get("reviewer")),
                reason=reason,
                decided_at=_utc_now_iso(),
            )
        except KeyError as exc:
            raise _error("candidate_not_found", f"AI Rescue candidate {candidate_id} was not found", 404) from exc
        return {"status": decision.decision, "candidate_id": candidate_id, "reason": reason}

    @app.post("/api/monitor/radar-baseline-reset")
    async def radar_baseline_reset(payload: dict[str, Any]) -> dict[str, Any]:
        mode = str(payload.get("mode") or "").strip()
        if mode not in {"dry-run", "apply"}:
            raise _error("invalid_mode", "mode must be dry-run or apply", 400)
        backup_path = _optional_text(payload.get("backup_path"))
        if not backup_path:
            raise _error("backup_path_required", "backup_path is required", 400)
        if mode == "apply" and payload.get("confirm") != "RESET_RADAR_BASELINE":
            raise _error("confirmation_required", "Reset apply requires RESET_RADAR_BASELINE confirmation", 400)
        baseline_started_at = _optional_text(payload.get("baseline_started_at")) or _utc_now_iso()
        try:
            return store.reset_radar_baseline(mode=mode, backup_path=backup_path, baseline_started_at=baseline_started_at)
        except ValueError as exc:
            raise _error("invalid_reset", str(exc), 400) from exc

    @app.post("/api/monitor/card-dismissals")
    async def dismiss_card_context(payload: dict[str, Any]) -> dict[str, Any]:
        surface = str(payload.get("surface") or "").strip()
        target_context = str(payload.get("target_context") or "").strip()
        video_id = _optional_text(payload.get("video_id"))
        candidate_id = _optional_int(payload.get("candidate_id"))
        if not surface:
            raise _error("missing_surface", "Dismissal surface is required", 400)
        if not target_context:
            raise _error("missing_target_context", "Dismissal target_context is required", 400)
        if video_id is None and candidate_id is None:
            raise _error("missing_dismissal_subject", "Dismissal requires video_id or candidate_id", 400)
        try:
            result = store.upsert_card_context_dismissal(
                surface=surface,
                target_context=target_context,
                video_id=video_id,
                candidate_id=candidate_id,
                dismissed_at=_utc_now_iso(),
                dismissed_by=_optional_text(payload.get("dismissed_by")),
                reason=_optional_text(payload.get("reason")) or "operator-dismissed",
            )
        except ValueError as exc:
            raise _error(str(exc), "Invalid dismissal payload", 400) from exc
        return {"status": result["status"], "context_key": result["context_key"]}

    @app.get("/api/monitor/cards")
    async def list_monitor_cards(limit: int | None = None, offset: int = 0, target_country: str | None = None) -> dict[str, Any]:
        safe_limit = _safe_page_limit(limit, settings=settings)
        safe_offset = max(0, int(offset))
        now = _utc_now_iso()
        target = normalize_country(target_country) if target_country else None
        if target == "important":
            total = store.count_important_cards(now=now)
            target_cards = store.list_important_cards(limit=safe_limit, offset=safe_offset, now=now)
        else:
            total = store.count_target_cards(target_country=target_country, now=now)
            target_cards = store.list_target_cards(target_country=target_country, limit=safe_limit, offset=safe_offset, now=now)
        degraded_reasons = _monitor_card_degraded_reasons(settings=settings)
        response: dict[str, Any] = {
            "status": "degraded" if degraded_reasons else "ok",
            "degraded": bool(degraded_reasons),
            "items": [_target_card_to_dict(card, default_classification_version=settings.classification_version) for card in target_cards],
            "pagination": _pagination(total=total, limit=safe_limit, offset=safe_offset),
        }
        if degraded_reasons:
            response["degraded_reasons"] = degraded_reasons
        return response

    @app.get("/api/monitor/summary")
    async def monitor_summary() -> dict[str, Any]:
        counts = store.target_status_counts(now=_utc_now_iso())
        return {
            "targets": [
                {"country": country, "label": _country_label(country), **counts[country]}
                for country in TARGET_COUNTRY_ORDER
            ],
            "basura_count": store.count_rejected_videos(now=_utc_now_iso()),
            "classification": {
                "version": settings.classification_version,
                "stale_count": store.count_stale_classification_candidates(
                    classification_version=settings.classification_version
                ),
            },
        }

    @app.get("/api/monitor/basura")
    async def list_basura(limit: int | None = None, offset: int = 0) -> dict[str, Any]:
        safe_limit = _safe_page_limit(limit, settings=settings)
        safe_offset = max(0, int(offset))
        page = store.list_rejected_videos(limit=safe_limit, offset=safe_offset, now=_utc_now_iso())
        return {
            "total": page.total,
            "pagination": _pagination(total=page.total, limit=safe_limit, offset=safe_offset),
            "items": [
                _rejected_video_to_dict(item, default_classification_version=settings.classification_version)
                for item in page.items
            ],
        }

    @app.get("/api/monitor/channels")
    async def list_channels() -> dict[str, Any]:
        return {"channels": [_channel_to_dict(channel) for channel in store.list_channels()]}

    @app.post("/api/monitor/channels", status_code=201)
    async def add_channel(payload: dict[str, Any]) -> dict[str, Any]:
        country = str(payload.get("country") or "").strip().casefold()
        label = str(payload.get("label") or "").strip()
        url = _optional_text(payload.get("url"))
        youtube_channel_id = _optional_text(payload.get("channel_id") or payload.get("youtube_channel_id"))
        enabled = bool(payload.get("enabled", True))
        if not country:
            raise _error("missing_country", "Channel country is required", 400)
        if not label:
            raise _error("missing_label", "Channel label is required", 400)
        if not url and not youtube_channel_id:
            raise _error("missing_channel_source", "Channel url or channel_id is required", 400)
        if url:
            if channel_resolver is None:
                raise _error("channel_resolver_unavailable", "YouTube channel resolver is not configured", 503)
            metadata = channel_resolver.resolve_channel(url)
            youtube_channel_id = metadata.channel_id
            uploads_playlist_id = metadata.uploads_playlist_id
        else:
            uploads_playlist_id = _optional_text(payload.get("uploads_playlist_id"))
        record = store.upsert_channel(
            ChannelRecord(
                country=country,
                label=label,
                source_url=url,
                youtube_channel_id=youtube_channel_id or "",
                uploads_playlist_id=uploads_playlist_id,
                enabled=enabled,
            )
        )
        return _channel_to_dict(record)

    @app.patch("/api/monitor/channels/{channel_id}")
    async def update_channel(channel_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        record = store.update_channel(
            channel_id,
            country=_optional_text(payload.get("country")),
            label=_optional_text(payload.get("label")),
            enabled=payload.get("enabled") if "enabled" in payload else None,
        )
        if record is None:
            raise _error("channel_not_found", f"Channel {channel_id} was not found", 404)
        return _channel_to_dict(record)

    @app.get("/api/monitor/websub")
    async def websub_challenge(request: Request) -> PlainTextResponse:
        if settings.callback_secret and request.query_params.get("hub.verify_token") != settings.callback_secret:
            raise _error("invalid_verify_token", "Invalid WebSub verify token", 403)
        challenge = request.query_params.get("hub.challenge")
        if not challenge:
            raise _error("missing_challenge", "Missing WebSub challenge", 400)
        return PlainTextResponse(challenge)

    @app.post("/api/monitor/websub", status_code=202)
    async def websub_callback(request: Request) -> dict[str, Any]:
        body = await request.body()
        if settings.callback_secret and request.query_params.get("secret") == settings.callback_secret:
            pass
        else:
            try:
                validate_websub_callback(body, dict(request.headers), settings.callback_secret)
            except CallbackValidationError as exc:
                raise _error("invalid_callback", str(exc), 403) from exc
        video_ids = parse_websub_video_ids(body)
        if discovery_worker is None:
            raise _error("discovery_worker_unavailable", "Discovery worker is not configured", 503)
        for video_id in video_ids:
            discovery_worker.process_video_id(video_id)
        return {"status": "accepted", "video_ids": video_ids}

    return app


def _preflight_response(
    *,
    settings: Settings,
    store: MonitorStore,
    channel_resolver: ChannelResolver | None = None,
    radar_client: Any | None = None,
    runtime_coordinator: Any | None = None,
) -> dict[str, Any]:
    channel_report = _channel_preflight(settings=settings, store=store, channel_resolver=channel_resolver)
    checks = {
        "sqlite": store.preflight(),
        "channels": channel_report,
        "radar": radar_client.preflight() if radar_client else _dependency_status(False, "radar_client_configured"),
        "youtube": _dependency_status(bool(settings.youtube_api_key), "youtube_api_key_configured"),
        "websub_callback": _dependency_status(bool(settings.callback_url), "callback_url_configured"),
        "websub_subscriptions": store.subscription_preflight(),
        "catchup": store.catchup_preflight(),
        "cleanup": store.cleanup_preflight(),
        "classification": _classification_preflight(settings=settings, store=store),
        "runtime": runtime_coordinator.status() if runtime_coordinator else _dependency_status(False, "runtime_configured"),
    }
    degraded = any(check.get("status") != "ready" for check in checks.values())
    return {"status": "degraded" if degraded else "ok", "checks": checks}


def _dependency_status(ready: bool, code: str) -> dict[str, Any]:
    if ready:
        return {"status": "ready", "code": code}
    return {"status": "degraded", "code": code, "message": "Not configured"}


def _classification_preflight(*, settings: Settings, store: MonitorStore) -> dict[str, Any]:
    latest = store.latest_classification_run()
    return {
        "status": "ready",
        "version": settings.classification_version,
        "latest_run_id": latest.id if latest else None,
        "stale_count": store.count_stale_classification_candidates(classification_version=settings.classification_version),
    }


def _ai_rescue_preflight_response(
    *, settings: Settings, store: MonitorStore, runtime_coordinator: Any | None = None
) -> dict[str, Any]:
    candidates = store.list_ai_rescue_candidates()
    rejections = store.list_ai_rescue_rejections()
    queue = store.ai_rescue_queue_snapshot(now=_utc_now_iso(), upcoming_limit=10)
    runtime_status = runtime_coordinator.status() if runtime_coordinator else {}
    runtime_enabled = "ai_rescue" in runtime_status.get("enabled", [])
    runtime_running = "ai_rescue" in runtime_status.get("running", [])
    degraded_reasons = _ai_rescue_degraded_reasons(
        settings=settings,
        runtime_enabled=runtime_enabled,
    )
    status = "disabled" if not settings.ai_rescue_enabled else "degraded" if degraded_reasons else "ready"
    response = {
        "status": status,
        "ready": status == "ready",
        "enabled": settings.ai_rescue_enabled,
        "worker_enabled": settings.ai_rescue_worker_enabled,
        "worker_ready": settings.ai_rescue_enabled and settings.ai_rescue_worker_enabled and runtime_enabled,
        "opencode": {
            "base_url_configured": bool(settings.ai_rescue_opencode_base_url),
            "model_configured": bool(settings.ai_rescue_opencode_model),
            "api_key_configured": bool(_ai_rescue_opencode_api_keys(settings)),
            "api_key_count": len(_ai_rescue_opencode_api_keys(settings)),
            "multi_key_configured": len(_ai_rescue_opencode_api_keys(settings)) > 1,
        },
        "catalog": {"configured": settings.catalog_config_path.exists()},
        "runtime": {"enabled": runtime_enabled, "running": runtime_running},
        "queue_counts": queue["counts"],
        "candidate_count": len(candidates),
        "rejection_count": len(rejections),
    }
    if degraded_reasons:
        response["degraded_reasons"] = degraded_reasons
    return response


def _ai_rescue_degraded_reasons(*, settings: Settings, runtime_enabled: bool) -> list[str]:
    if not settings.ai_rescue_enabled:
        return []
    reasons: list[str] = []
    if settings.ai_rescue_worker_enabled:
        if not _ai_rescue_opencode_api_keys(settings):
            reasons.append("opencode_api_key_missing")
        if not settings.ai_rescue_opencode_model:
            reasons.append("opencode_model_missing")
        if not settings.catalog_config_path.exists():
            reasons.append("catalog_missing")
        if not runtime_enabled:
            reasons.append("runtime_loop_disabled")
    return reasons


def _channel_preflight(
    *, settings: Settings, store: MonitorStore, channel_resolver: ChannelResolver | None
) -> dict[str, Any]:
    return _sync_channels_for_preflight_or_startup(settings=settings, store=store, channel_resolver=channel_resolver)


def _sync_channels_for_preflight_or_startup(
    *, settings: Settings, store: MonitorStore, channel_resolver: ChannelResolver | None
) -> dict[str, Any]:
    if channel_resolver is None:
        return validation_report_to_dict(load_and_validate_channel_config(settings.channels_config_path))
    return channel_sync_report_to_dict(
        sync_configured_channels(
            channels_path=settings.channels_config_path,
            store=store,
            resolver=channel_resolver,
        )
    )


def _build_channel_resolver(*, settings: Settings) -> YouTubeDataClient | None:
    if not settings.youtube_api_key:
        return None
    return YouTubeDataClient(api_key=settings.youtube_api_key)


def _channel_to_dict(record: ChannelRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "country": record.country,
        "label": record.label,
        "source_url": record.source_url,
        "youtube_channel_id": record.youtube_channel_id,
        "uploads_playlist_id": record.uploads_playlist_id,
        "enabled": record.enabled,
    }


def _monitor_card_to_dict(record: MonitorCardRecord) -> dict[str, Any]:
    return {
        "id": record.video_id,
        "video_id": record.video_id,
        "title": record.title,
        "country": record.country,
        "channel_label": record.channel_label,
        "published_at": record.published_at,
        "lifecycle": record.lifecycle,
        "matched": record.matched,
        "enqueue_status": record.enqueue_status,
        "radar_job_id": record.radar_job_id,
        "attempt_count": record.attempt_count,
        "last_error": record.last_error,
        "mention_status": "pending_summary",
        "mention_counts": [],
    }


def _target_card_to_dict(record: dict[str, Any], *, default_classification_version: str) -> dict[str, Any]:
    target_country = normalize_country(record.get("target_country"))
    source_country = normalize_country(record.get("source_country"))
    mention_counts = _parse_mention_counts(record.get("mention_counts_json"))
    status = str(record.get("status") or "")
    approval_source = str(record.get("approval_source") or "title_classifier")
    last_error = record.get("last_error")
    failure = _operator_failure(status=status, reason=last_error)
    item = {
        "id": f"{record.get('video_id')}:{target_country}",
        "video_id": record.get("video_id"),
        "title": record.get("title"),
        "url": record.get("url"),
        "target_country": target_country,
        "target_country_label": _country_label(target_country),
        "source_country": source_country,
        "source_country_label": _country_label(source_country),
        "channel_label": record.get("channel_label"),
        "published_at": record.get("published_at"),
        "status": status,
        "approval_source": approval_source,
        "display_status": _display_status(status=status, approval_source=approval_source, last_error=last_error),
        "radar_job_id": record.get("radar_job_id"),
        "last_error": last_error,
        "mention_status": "ready" if mention_counts or status == "transcrito" else "pending_summary",
        "mention_counts": mention_counts,
        "classification_version": record.get("classification_version") or default_classification_version,
    }
    if target_country == "important":
        item.update(
            {
                "important": True,
                "important_reason": record.get("classification_reason") or record.get("important_mode") or record.get("approval_source"),
                "important_rule": _parse_json_object(record.get("important_rule_json")),
            }
        )
    if failure["code"]:
        item["failure_code"] = failure["code"]
        item["failure_category"] = failure["category"]
    return item


def _ai_rescue_summary(*, candidates: list[Any], rejection_count: int) -> dict[str, Any]:
    by_country: dict[str, int] = {}
    for candidate in candidates:
        by_country[candidate.target_country] = by_country.get(candidate.target_country, 0) + 1
    return {"candidate_count": len(candidates), "rejection_count": rejection_count, "by_country": by_country}


def _ai_rescue_queue_to_dict(record: Any | None) -> dict[str, Any] | None:
    if record is None:
        return None
    failure = _operator_failure(status=record.status, reason=record.last_error)
    item = {
        "id": record.id,
        "video_id": record.video_id,
        "source_country": normalize_country(record.source_country),
        "source_country_label": _country_label(record.source_country),
        "status": record.status,
        "attempt_count": record.attempt_count,
        "next_attempt_at": record.next_attempt_at,
        "last_error": record.last_error,
    }
    if failure["code"]:
        item["display_status"] = failure["label"]
        item["failure_code"] = failure["code"]
        item["failure_category"] = failure["category"]
    return item


def _ai_rescue_candidate_to_dict(store: MonitorStore, candidate: Any, *, include_evidence: bool) -> dict[str, Any]:
    video = store.get_video(candidate.video_id)
    queue_item = store.get_ai_rescue_queue_item(candidate.queue_id)
    item: dict[str, Any] = {
        "id": candidate.id,
        "video_id": candidate.video_id,
        "title": video.title if video else None,
        "url": video.url if video else None,
        "published_at": video.published_at if video else None,
        "source_country": normalize_country(queue_item.source_country if queue_item else None),
        "source_country_label": _country_label(queue_item.source_country if queue_item else None),
        "target_country": candidate.target_country,
        "target_country_label": _country_label(candidate.target_country),
        "status": candidate.status,
        "score": candidate.score,
        "summary_es": candidate.summary_es,
        "angle_es": candidate.angle_es,
        "risk": candidate.risk,
        "risks": _parse_json_array(candidate.risks_json),
        "evidence_count": len(candidate.evidence),
    }
    if include_evidence:
        item["evidence"] = [_ai_rescue_evidence_to_dict(evidence) for evidence in candidate.evidence]
        item["raw_response"] = _parse_json_object(candidate.raw_response_json)
    return item


def _ai_rescue_evidence_to_dict(record: Any) -> dict[str, Any]:
    return {
        "start_ms": record.start_ms,
        "end_ms": record.end_ms,
        "text": record.text,
        "translation_es": record.translation_es,
        "explanation_es": record.explanation_es,
    }


def _ai_rescue_rejection_to_dict(record: Any) -> dict[str, Any]:
    target_country = normalize_country(record.target_country) if record.target_country else None
    failure = _operator_failure(status="rejected", reason=record.reason)
    item = {
        "id": record.id,
        "video_id": record.video_id,
        "candidate_id": record.candidate_id,
        "target_country": target_country,
        "target_country_label": _country_label(target_country),
        "source": record.source,
        "reason": record.reason,
        "details": _parse_json_object(record.details_json),
    }
    if failure["code"]:
        item["display_status"] = failure["label"]
        item["failure_code"] = failure["code"]
        item["failure_category"] = failure["category"]
    return item


def _promoted_match_to_dict(record: Any) -> dict[str, Any]:
    return {
        "video_id": record.video_id,
        "target_country": record.target_country,
        "status": record.status,
        "approval_source": record.approval_source,
        "display_status": _display_status(status=record.status, approval_source=record.approval_source),
    }


def _retention_report_to_dict(report: Any) -> dict[str, Any]:
    return {
        "summary": report.summary,
        "items": [
            {
                "video_id": item.video_id,
                "url": item.url,
                "detected_at": item.detected_at,
                "lifecycle": item.lifecycle,
                "states": item.states,
                "transcript_refs": item.transcript_refs,
                "planned_deletions": item.planned_deletions,
                "transcript_artifacts": item.transcript_artifacts,
            }
            for item in report.items
        ],
    }


def _display_status(*, status: str, approval_source: str | None, last_error: str | None = None) -> str:
    if _is_geo_blocked_status(status) or _is_geo_blocked_status(last_error):
        return "GEO-BLOQUEADO"
    failure = _operator_failure(status=status, reason=last_error)
    if failure["label"]:
        return failure["label"]
    if status == "aprobado" and approval_source == "ai_rescue":
        return "RESCATADO IA"
    return status.upper()


def _is_geo_blocked_status(value: str | None) -> bool:
    normalized = str(value or "").strip().casefold().replace("-", "_")
    return normalized in {"geo_blocked", "yt_dlp_geo_blocked"}


def _operator_failure(*, status: str | None, reason: str | None) -> dict[str, str | None]:
    normalized_status = _normalize_failure_token(status)
    normalized_reason = _normalize_failure_token(reason)
    token = normalized_reason or normalized_status
    if not token:
        return {"code": None, "category": None, "label": None}
    if token in {"geo_blocked", "yt_dlp_geo_blocked", "youtube_geo_blocked"}:
        return {"code": token, "category": "youtube_geo_blocked", "label": "GEO-BLOQUEADO"}
    if token in {"yt_dlp_bot_check", "youtube_bot_check"}:
        return {"code": token, "category": "youtube_bot_check", "label": "BLOQUEO YOUTUBE"}
    if token in {"yt_dlp_timeout", "youtube_download_timeout", "opencode_timeout", "timeout"}:
        return {"code": token, "category": "timeout", "label": "TIMEOUT"}
    if token in {"yt_dlp_live_pending", "youtube_live_pending", "live_pending"}:
        return {"code": token, "category": "youtube_live_pending", "label": "LIVE PENDIENTE"}
    if token in {"yt_dlp_copyright_blocked", "youtube_copyright_blocked", "copyright_blocked"}:
        return {"code": token, "category": "youtube_copyright_blocked", "label": "COPYRIGHT"}
    if token in {"no_subtitles", "no_transcript", "language_unavailable", "empty_transcript"}:
        return {"code": token, "category": "no_subtitles", "label": "SIN SUBTÍTULOS"}
    if token in {"transcripts_disabled", "subtitles_disabled"}:
        return {"code": token, "category": "subtitles_disabled", "label": "SUBTÍTULOS OFF"}
    if token in {"video_unavailable", "yt_dlp_private_or_removed", "private_or_removed", "unavailable", "private", "removed", "yt_dlp_age_restricted"}:
        return {"code": token, "category": "video_unavailable", "label": "NO DISPONIBLE"}
    if token in {"ffmpeg_failed", "ffmpeg_timeout", "yt_dlp_unavailable", "yt_dlp_no_output", "analysis_error", "opencode_server_error", "opencode_transport", "opencode_auth", "provider_fetch_error", "fetch_error"}:
        return {"code": token, "category": "technical_failure", "label": "FALLO TÉCNICO"}
    if normalized_status == "error" or token.endswith("_error") or token.endswith("_failed"):
        return {"code": token, "category": "unknown_failure", "label": "ERROR"}
    return {"code": None, "category": None, "label": None}


def _normalize_failure_token(value: str | None) -> str | None:
    token = str(value or "").strip().casefold().replace("-", "_")
    return token or None


def _rejected_video_to_dict(record: Any, *, default_classification_version: str) -> dict[str, Any]:
    source_country = normalize_country(record.source_country)
    return {
        "video_id": record.video_id,
        "title": record.title,
        "url": record.url,
        "source_country": source_country,
        "source_country_label": _country_label(source_country),
        "channel_label": record.channel_label,
        "published_at": record.published_at,
        "reason": record.reason,
        "match_reasons": _parse_json_array(record.match_reason_json),
        "classification_version": record.classification_version or default_classification_version,
    }


def _parse_mention_counts(value: str | None) -> list[dict[str, Any]]:
    items = _parse_json_array(value)
    counts: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            count = int(item.get("count") or 0)
        except (TypeError, ValueError):
            continue
        if count <= 0:
            continue
        normalized = {"label": item.get("label"), "count": count}
        if item.get("timestamps"):
            normalized["timestamps"] = item.get("timestamps")
        counts.append(normalized)
    return counts


def _parse_json_array(value: str | None) -> list[Any]:
    if not value:
        return []
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return []
    return decoded if isinstance(decoded, list) else []


def _parse_json_object(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None


def _country_label(country: str | None) -> str | None:
    labels = {
        "important": "IMPORTANTES",
        "ecuador": "Ecuador",
        "colombia": "Colombia",
        "argentina": "Argentina",
        "uruguay": "Uruguay",
        "paraguay": "Paraguay",
        "mexico": "México",
    }
    if not country:
        return None
    return labels.get(country, country.title())


def _monitor_card_degraded_reasons(*, settings: Settings) -> list[str]:
    reasons: list[str] = []
    if not settings.radar_url or not settings.radar_api_key:
        reasons.append("radar_client_unavailable")
    return reasons


def _safe_page_limit(limit: int | None, *, settings: Settings) -> int:
    requested = settings.backend_card_default_limit if limit is None else int(limit)
    return max(1, min(requested, settings.backend_card_max_limit))


def _pagination(*, total: int, limit: int, offset: int) -> dict[str, Any]:
    return {"limit": limit, "offset": offset, "total": total, "has_more": offset + limit < total}


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise _error("invalid_candidate_id", "candidate_id must be an integer", 400) from exc


def _require_confirmation(payload: dict[str, Any]) -> None:
    if payload.get("confirmed") is not True:
        raise _error("confirmation_required", "AI Rescue decisions require explicit confirmation", 400)


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _build_discovery_worker(*, settings: Settings, store: MonitorStore) -> DiscoveryWorker | None:
    if not settings.youtube_api_key or not settings.catalog_config_path.exists():
        return None
    return DiscoveryWorker(
        store=store,
        youtube=YouTubeDataClient(api_key=settings.youtube_api_key),
        classifier=ClassificationService(
            matcher=TitleMatcher(load_title_catalog(settings.catalog_config_path)),
            classification_version=settings.classification_version,
        ),
        ai_rescue_enabled=settings.ai_rescue_enabled,
    )


def _build_runtime_coordinator(
    *, settings: Settings, store: MonitorStore, discovery_worker: DiscoveryWorker | None, radar_client: RadarClient
) -> RuntimeCoordinator:
    enqueue_worker = _build_enqueue_worker(settings=settings, store=store, radar_client=radar_client)
    transcript_sync_worker = _build_transcript_sync_worker(
        settings=settings,
        store=store,
        radar_client=radar_client,
        enqueue_due=enqueue_worker.enqueue_due if enqueue_worker else None,
    )
    cleanup_worker = CleanupWorker(store=store, retention_hours=settings.cleanup_retention_hours, mode=settings.cleanup_mode)
    websub_worker = _build_websub_worker(settings=settings, store=store)
    catchup_worker = _build_catchup_worker(settings=settings, store=store, discovery_worker=discovery_worker)
    ai_rescue_worker = _build_ai_rescue_worker(settings=settings, store=store)
    pending_live_duty = getattr(discovery_worker, "poll_pending_live", None)
    loops = [
        RuntimeLoop(
            name="pending_live",
            interval_seconds=settings.worker_pending_live_interval_seconds,
            enabled=settings.worker_pending_live_enabled and pending_live_duty is not None,
            duty=pending_live_duty or _noop,
        ),
        RuntimeLoop(
            name="enqueue",
            interval_seconds=settings.worker_enqueue_interval_seconds,
            enabled=settings.worker_enqueue_enabled and enqueue_worker is not None,
            duty=enqueue_worker.enqueue_due if enqueue_worker else _noop,
        ),
        RuntimeLoop(
            name="transcript_sync",
            interval_seconds=settings.worker_transcript_sync_interval_seconds,
            enabled=settings.worker_transcript_sync_enabled and transcript_sync_worker is not None,
            duty=transcript_sync_worker.sync_once if transcript_sync_worker else _noop,
        ),
        RuntimeLoop(
            name="cleanup",
            interval_seconds=settings.worker_cleanup_interval_seconds,
            enabled=settings.worker_cleanup_enabled,
            duty=cleanup_worker.cleanup_old_rows,
        ),
        RuntimeLoop(
            name="websub",
            interval_seconds=settings.worker_websub_interval_seconds,
            enabled=settings.worker_websub_enabled and websub_worker is not None,
            duty=websub_worker.renew_all if websub_worker else _noop,
        ),
        RuntimeLoop(
            name="catchup",
            interval_seconds=settings.worker_catchup_interval_seconds,
            initial_delay_seconds=settings.worker_catchup_initial_delay_seconds,
            enabled=settings.worker_catchup_enabled and catchup_worker is not None,
            duty=catchup_worker.run_once if catchup_worker else _noop,
        ),
        RuntimeLoop(
            name="ai_rescue",
            interval_seconds=settings.ai_rescue_worker_interval_seconds,
            enabled=settings.ai_rescue_enabled and settings.ai_rescue_worker_enabled and ai_rescue_worker is not None,
            duty=ai_rescue_worker.drain_due if ai_rescue_worker else _noop,
        ),
    ]
    return RuntimeCoordinator(loops=loops)


def _build_enqueue_worker(*, settings: Settings, store: MonitorStore, radar_client: RadarClient) -> EnqueueWorker | None:
    if not settings.radar_url or not settings.radar_api_key:
        return None
    return EnqueueWorker(store=store, radar=radar_client)


def _build_transcript_sync_worker(
    *, settings: Settings, store: MonitorStore, radar_client: RadarClient, enqueue_due: Callable[[], object] | None = None
) -> TranscriptSyncWorker | None:
    if not settings.radar_url or not settings.radar_api_key:
        return None
    return TranscriptSyncWorker(store=store, radar=radar_client, enqueue_due=enqueue_due)


def _build_websub_worker(*, settings: Settings, store: MonitorStore) -> WebSubRenewalWorker | None:
    if not settings.callback_url:
        return None
    return WebSubRenewalWorker(
        store=store,
        websub=WebSubClient(callback_url=settings.callback_url),
        callback_url=settings.callback_url,
        lease_seconds=settings.websub_lease_seconds,
    )


def _build_catchup_worker(
    *, settings: Settings, store: MonitorStore, discovery_worker: DiscoveryWorker | None
) -> CatchupWorker | None:
    if discovery_worker is None or not settings.youtube_api_key:
        return None
    return CatchupWorker(
        store=store,
        youtube=YouTubeDataClient(api_key=settings.youtube_api_key),
        discovery=discovery_worker,
        page_limit=settings.catchup_page_limit,
        item_limit=settings.catchup_item_limit,
    )


def _build_ai_rescue_worker(*, settings: Settings, store: MonitorStore) -> AiRescueWorker | None:
    if not settings.ai_rescue_enabled or not settings.ai_rescue_worker_enabled:
        return None
    if (
        not settings.ai_rescue_opencode_model
        or not _ai_rescue_opencode_api_keys(settings)
        or not settings.catalog_config_path.exists()
    ):
        return None
    return AiRescueWorker(
        store=store,
        subtitles=CompositeSubtitleProvider(
            primary=YouTubeTranscriptSubtitleProvider(),
            fallback=YtDlpSubtitleProvider(
                binary=settings.ai_rescue_yt_dlp_binary,
                cookies_path=settings.ai_rescue_yt_dlp_cookies_path,
            ),
        ),
        analyzer=AiRescueAnalyzer(
            client=OpenCodeGoClient(
                base_url=settings.ai_rescue_opencode_base_url,
                model=settings.ai_rescue_opencode_model,
                api_key=settings.ai_rescue_opencode_api_key,
                api_keys=_ai_rescue_opencode_api_keys(settings),
            ),
            catalog=load_title_catalog(settings.catalog_config_path),
            subtitle_policy=SubtitlePayloadPolicy(
                max_characters=settings.ai_rescue_subtitle_max_characters,
                hard_max_characters=settings.ai_rescue_subtitle_hard_max_characters,
                max_segments=settings.ai_rescue_subtitle_max_segments,
            ),
        ),
        enabled=True,
        retry_attempts=settings.ai_rescue_retry_attempts,
        retry_interval_seconds=settings.ai_rescue_retry_interval_seconds,
        processing_timeout_seconds=settings.ai_rescue_processing_timeout_seconds,
    )


def _ai_rescue_opencode_api_keys(settings: Settings) -> list[str]:
    configured = [key.strip() for key in settings.ai_rescue_opencode_api_keys if key and key.strip()]
    if configured:
        return configured
    legacy = settings.ai_rescue_opencode_api_key.strip()
    return [legacy] if legacy else []


def _noop() -> None:
    return None


app = create_app()
