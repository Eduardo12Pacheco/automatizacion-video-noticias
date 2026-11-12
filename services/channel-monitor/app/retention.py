from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Protocol

from .store import MonitorStore, RetentionDryRunItem, RetentionDryRunReport


class TranscriptRetentionPlanner(Protocol):
    def plan_cleanup(self, *, job_ids: list[str], urls: list[str], video_ids: list[str], mode: str) -> dict[str, Any]: ...


def _now_iso() -> str:
    return datetime.now(tz=UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _add_minutes(value: str, minutes: int) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parsed + timedelta(minutes=minutes)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


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
