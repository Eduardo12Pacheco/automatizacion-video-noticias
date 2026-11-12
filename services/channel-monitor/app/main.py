from __future__ import annotations

import secrets
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .boundary_client import BoundaryRequestError, ChannelNetworkBoundaryClient
from .channel_bootstrap import ChannelResolver, channel_sync_report_to_dict, sync_configured_channels
from .radar_client import RadarClient
from .rss_client import RssChannelClient
from .runtime import RuntimeCoordinator, RuntimeLoop
from .settings import NETWORK_MODE_PROTECTED, Settings, load_and_validate_channel_config, load_channel_config, load_settings, validation_report_to_dict
from .store import ChannelRecord, MonitorCardRecord, MonitorStore
from .title_matcher import TARGET_COUNTRY_ORDER, TitleMatcher, load_title_catalog, normalize_country
from .transcript_service_client import TranscriptServiceSubtitleProvider
from .workers import ClassificationService, CatchupWorker, CleanupWorker, DiscoveryWorker, EnqueueWorker, TranscriptSyncWorker
from .youtube_client import CompositeSubtitleProvider, YouTubeTranscriptSubtitleProvider, YtDlpSubtitleProvider


def _error(code: str, message: str, status_code: int) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _authorize(settings: Settings, api_key: str | None) -> None:
    if not settings.api_key:
        raise _error("missing_api_key_config", "Channel monitor API key is not configured", 500)
    if not api_key or not secrets.compare_digest(api_key, settings.api_key):
        raise _error("unauthorized", "Invalid or missing API key", 401)


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
        public_paths = {"/api/monitor/live"}
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
            # The resolver always returns metadata; baseline is stamped by the
            # canonical sync path. We deliberately leave baseline_started_at
            # untouched so the SQL coalesce preserves any prior baseline.
            baseline_started_at = None
        else:
            explicit_playlist = _optional_text(payload.get("uploads_playlist_id"))
            existing = store.find_channel_by_youtube_id(youtube_channel_id or "")
            # Bypass path: mirror the resolver-bypass derivation in
            # channel_bootstrap._metadata_for_channel so brand-new channels
            # created via the API do not end up with uploads_playlist_id=NULL
            # (which makes them invisible to the catchup worker).
            if explicit_playlist:
                uploads_playlist_id = explicit_playlist
            elif existing and existing.uploads_playlist_id:
                uploads_playlist_id = existing.uploads_playlist_id
            else:
                uploads_playlist_id = f"UU{youtube_channel_id[2:]}" if youtube_channel_id and youtube_channel_id.startswith("UC") else None
            # Stamp baseline_started_at only for brand-new channels so the
            # catchup worker only ingests content published from this moment
            # forward. For existing channels, pass None and let
            # upsert_channel coalesce preserve any baseline already set.
            baseline_started_at = _utc_now_iso() if existing is None else None
        record = store.upsert_channel(
            ChannelRecord(
                country=country,
                label=label,
                source_url=url,
                youtube_channel_id=youtube_channel_id or "",
                uploads_playlist_id=uploads_playlist_id,
                enabled=enabled,
                baseline_started_at=baseline_started_at,
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
            uploads_playlist_id=_optional_text(payload.get("uploads_playlist_id")),
        )
        if record is None:
            raise _error("channel_not_found", f"Channel {channel_id} was not found", 404)
        return _channel_to_dict(record)

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
        "channel_feed": _dependency_status(True, "youtube_rss_no_api_key"),
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


def _channel_preflight(
    *, settings: Settings, store: MonitorStore, channel_resolver: ChannelResolver | None
) -> dict[str, Any]:
    report = validation_report_to_dict(load_and_validate_channel_config(settings.channels_config_path))
    configured_count = None
    if report["status"] == "ready":
        config = load_channel_config(settings.channels_config_path)
        configured_count = sum(len(country.channels) for country in config.countries)
    report.update(
        {
            "configured_count": configured_count,
            "stored_count": len(store.list_channels()),
            "sync": {
                "status": "deferred",
                "code": "channel_sync_deferred",
                "message": "Channel resolver sync is deferred to startup and worker paths.",
            },
        }
    )
    return report


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


def _build_channel_resolver(*, settings: Settings) -> RssChannelClient | ChannelNetworkBoundaryClient | None:
    if _protected_network_mode(settings):
        return _build_boundary_client(settings=settings)
    return RssChannelClient()


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
        "channel_priority_rank": _optional_int(record.get("channel_priority_rank")),
        "published_at": record.get("published_at"),
        "created_at": record.get("created_at"),
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
    if token in {"yt_dlp_timeout", "youtube_download_timeout", "timeout"}:
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
    if token in {"ffmpeg_failed", "ffmpeg_timeout", "yt_dlp_unavailable", "yt_dlp_no_output", "analysis_error", "provider_fetch_error", "fetch_error"}:
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
        "aurenia": "Aurenia",
        "montelia": "Montelia",
        "valdoria": "Valdoria",
        "rivamar": "Rivamar",
        "bosquemar": "Bosquemar",
        "terramar": "Terramar",
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


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _build_discovery_worker(*, settings: Settings, store: MonitorStore) -> DiscoveryWorker | None:
    if not settings.catalog_config_path.exists():
        return None
    if _protected_network_mode(settings):
        youtube = _require_boundary_client(settings=settings)
    else:
        youtube = RssChannelClient(
            channel_ids_provider=lambda: [
                channel.youtube_channel_id
                for channel in store.list_channels()
                if channel.youtube_channel_id
            ]
        )
    return DiscoveryWorker(
        store=store,
        youtube=youtube,
        classifier=ClassificationService(
            matcher=TitleMatcher(load_title_catalog(settings.catalog_config_path)),
            classification_version=settings.classification_version,
        ),
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
    catchup_worker = _build_catchup_worker(settings=settings, store=store, discovery_worker=discovery_worker)
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
            name="catchup",
            interval_seconds=settings.worker_catchup_interval_seconds,
            initial_delay_seconds=settings.worker_catchup_initial_delay_seconds,
            enabled=settings.worker_catchup_enabled and catchup_worker is not None,
            duty=catchup_worker.run_once if catchup_worker else _noop,
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


def _build_catchup_worker(
    *, settings: Settings, store: MonitorStore, discovery_worker: DiscoveryWorker | None
) -> CatchupWorker | None:
    if discovery_worker is None:
        return None
    if _protected_network_mode(settings):
        youtube = _require_boundary_client(settings=settings)
    else:
        youtube = RssChannelClient(
            channel_ids_provider=lambda: [
                channel.youtube_channel_id
                for channel in store.list_channels()
                if channel.youtube_channel_id
            ]
        )
    return CatchupWorker(
        store=store,
        youtube=youtube,
        discovery=discovery_worker,
        page_limit=settings.catchup_page_limit,
        item_limit=settings.catchup_item_limit,
    )


def _protected_network_mode(settings: Settings) -> bool:
    return str(settings.network_mode or "").strip().casefold() == NETWORK_MODE_PROTECTED


def _build_boundary_client(*, settings: Settings) -> ChannelNetworkBoundaryClient | None:
    if not settings.network_boundary_url.strip() or not settings.network_boundary_token.strip():
        return None
    return ChannelNetworkBoundaryClient(
        base_url=settings.network_boundary_url,
        token=settings.network_boundary_token,
    )


def _require_boundary_client(*, settings: Settings) -> ChannelNetworkBoundaryClient:
    boundary = _build_boundary_client(settings=settings)
    if boundary is None:
        raise BoundaryRequestError(
            code="boundary_misconfigured",
            message="Channel network boundary URL/token are required in protected mode",
            retryable=False,
        )
    return boundary


def _noop() -> None:
    return None


app = create_app()
