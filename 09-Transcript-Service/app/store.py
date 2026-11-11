from __future__ import annotations

import json
import os
import re
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .models import (
    HistoryItem,
    JobRecord,
    JobStatus,
    MentionArtifact,
    MentionMatch,
    TargetProfile,
    TranscriptArtifact,
    TranscriptSegment,
)


ACTIVE_STATUSES = {JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCEL_REQUESTED, JobStatus.DELETE_REQUESTED}
JOB_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")


class JobStoreError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class JobIdError(JobStoreError):
    pass


class JobNotFoundError(JobStoreError):
    pass


class ArtifactWriteError(JobStoreError):
    pass


class ArtifactCorruptError(JobStoreError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def format_timestamp(start_ms: int) -> str:
    total_seconds = max(0, start_ms // 1000)
    minutes, seconds = divmod(total_seconds, 60)
    return f"{minutes:02d}:{seconds:02d}"


def transcript_text(segments: list[TranscriptSegment]) -> str:
    return "\n".join(f"({format_timestamp(segment.start_ms)}) {segment.text}" for segment in segments)


class JobStore:
    def __init__(self, runtime_dir: Path | str):
        self.runtime_dir = Path(runtime_dir)
        self.jobs_dir = self.runtime_dir / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.index_path = self.jobs_dir / "index.json"
        if not self.index_path.exists():
            self._write_json(self.index_path, {"items": []})

    def create_job(
        self,
        *,
        url: str,
        target: dict[str, Any] | TargetProfile | None = None,
        countries: list[str] | None = None,
        extra_keywords: list[str],
    ) -> JobRecord:
        job_id = uuid.uuid4().hex
        timestamp = _now()
        selected_countries = [country.strip().casefold() for country in (countries or []) if country.strip()]
        resolved_target = target if isinstance(target, TargetProfile) or target is None else TargetProfile(**target)
        if resolved_target is None and selected_countries:
            resolved_target = TargetProfile(type="country", name=selected_countries[0].title())
        record = JobRecord(
            job_id=job_id,
            url=url,
            target=resolved_target,
            selected_countries=selected_countries,
            extra_keywords=extra_keywords,
            status=JobStatus.QUEUED,
            created_at=timestamp,
            updated_at=timestamp,
        )
        self._job_dir(job_id).mkdir(parents=True, exist_ok=True)
        self._save_job(record)
        return record

    def get_job(self, job_id: str) -> JobRecord:
        return JobRecord(**self._read_json(self._job_path(job_id)))

    def list_history(self) -> list[HistoryItem]:
        records = [self.get_job(item["job_id"]) for item in self._read_index()["items"]]
        records.sort(key=lambda record: record.updated_at, reverse=True)
        return [
            HistoryItem(
                job_id=record.job_id,
                status=record.status,
                target=record.target,
                title=record.title,
                selected_countries=record.selected_countries,
                detected_language=record.detected_language,
                artifacts=record.artifacts,
                created_at=record.created_at,
                updated_at=record.updated_at,
                mention_count=record.mention_count,
            )
            for record in records
        ]

    def has_active_job(self) -> bool:
        return any(self.get_job(item["job_id"]).status in ACTIVE_STATUSES for item in self._read_index()["items"])

    def recover_orphaned_active_jobs(self) -> list[JobRecord]:
        recovered: list[JobRecord] = []
        for item in self._read_index()["items"]:
            record = self.get_job(item["job_id"])
            if record.status not in ACTIVE_STATUSES:
                continue
            recovered.append(
                self._update_job(
                    record.job_id,
                    status=JobStatus.FAILED,
                    progress=100,
                    stage="failed",
                    delete_requested=False,
                    error={
                        "code": "service_restarted",
                        "message": "Job was interrupted by service restart",
                    },
                )
            )
        return recovered

    def cleanup_expired_job_artifacts(self, *, ttl_seconds: int, now: datetime | None = None) -> dict[str, list[str]]:
        if ttl_seconds <= 0:
            return {}
        cutoff = (now or datetime.now(timezone.utc)) - timedelta(seconds=ttl_seconds)
        removed: dict[str, list[str]] = {}
        for item in self._read_index()["items"]:
            record = self.get_job(item["job_id"])
            if record.status in ACTIVE_STATUSES:
                continue
            updated_at = self._parse_timestamp(record.updated_at)
            if updated_at >= cutoff:
                continue
            removed_names = self._remove_generated_job_artifacts(record.job_id)
            if removed_names:
                removed[record.job_id] = removed_names
        return removed

    def cleanup_linked_artifacts(
        self,
        *,
        job_ids: list[str],
        urls: list[str],
        video_ids: list[str],
        mode: str,
    ) -> dict[str, list[Any]]:
        if mode not in {"dry-run", "apply"}:
            raise ValueError("mode must be dry-run or apply")
        resolved, missing, errors = self._resolve_linked_cleanup_jobs(job_ids=job_ids, urls=urls, video_ids=video_ids)
        planned: list[dict[str, str]] = []
        deleted: list[dict[str, str]] = []
        skipped_active: list[str] = []
        for job_id in resolved:
            try:
                record = self.get_job(job_id)
            except JobStoreError:
                missing.append(job_id)
                continue
            if record.status in ACTIVE_STATUSES:
                skipped_active.append(job_id)
                continue
            item = {"kind": "job_dir", "job_id": job_id, "url": record.url}
            planned.append(item)
            if mode == "apply":
                self._delete_job_files(job_id)
                deleted.append(item)
        return {
            "planned": planned,
            "deleted": deleted,
            "missing": missing,
            "skipped_active": skipped_active,
            "errors": errors,
        }

    @staticmethod
    def _parse_timestamp(value: str) -> datetime:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    def mark_running(self, job_id: str) -> JobRecord:
        return self._update_job(job_id, status=JobStatus.RUNNING, progress=10, stage="running")

    def mark_succeeded(self, job_id: str) -> JobRecord:
        return self._update_job(job_id, status=JobStatus.SUCCEEDED, progress=100, stage="succeeded", error=None)

    def mark_failed(self, job_id: str, *, code: str, message: str) -> JobRecord:
        current = self.get_job(job_id)
        return self._update_job(job_id, status=JobStatus.FAILED, progress=current.progress, stage="failed", error={"code": code, "message": message})

    def update_metadata(self, job_id: str, **metadata: Any) -> JobRecord:
        return self._update_job(job_id, **metadata)

    def cancel_job(self, job_id: str) -> JobRecord:
        record = self.get_job(job_id)
        if record.status == JobStatus.QUEUED:
            self._remove_artifacts(job_id)
            return self._update_job(job_id, status=JobStatus.CANCELLED, progress=100, stage="cancelled")
        if record.status == JobStatus.RUNNING:
            return self._update_job(job_id, status=JobStatus.CANCEL_REQUESTED, stage="cancel_requested")
        return record

    def delete_job(self, job_id: str) -> JobRecord:
        record = self.get_job(job_id)
        if record.status in {JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCEL_REQUESTED, JobStatus.DELETE_REQUESTED}:
            return self._update_job(job_id, status=JobStatus.DELETE_REQUESTED, delete_requested=True, stage="delete_requested")
        deleted = JobRecord(**{**record.model_dump(mode="json"), "status": JobStatus.DELETED, "updated_at": _now()})
        self._delete_job_files(job_id)
        return deleted

    def should_stop(self, job_id: str) -> bool:
        record = self.get_job(job_id)
        if record.status in {JobStatus.CANCELLED, JobStatus.CANCEL_REQUESTED}:
            self._remove_artifacts(job_id)
            self._update_job(job_id, status=JobStatus.CANCELLED, progress=100, stage="cancelled")
            return True
        if record.delete_requested or record.status == JobStatus.DELETE_REQUESTED:
            self._delete_job_files(job_id)
            return True
        return False

    def save_transcript(self, job_id: str, segments: list[TranscriptSegment], *, detected_language: str | None = None) -> TranscriptArtifact:
        artifact = TranscriptArtifact(segments=segments, text=transcript_text(segments), detected_language=detected_language)
        self._write_json(self._job_dir(job_id) / "transcript.json", artifact.model_dump(mode="json"))
        self._update_job(job_id, artifacts={**self.get_job(job_id).artifacts, "transcript": True})
        return artifact

    def get_transcript(self, job_id: str) -> TranscriptArtifact:
        path = self._job_dir(job_id) / "transcript.json"
        if not path.exists():
            return TranscriptArtifact()
        return TranscriptArtifact(**self._read_json(path))

    def save_mentions(self, job_id: str, matches: list[MentionMatch], *, detected_language: str | None = None) -> MentionArtifact:
        artifact = MentionArtifact(matches=matches, detected_language=detected_language)
        self._write_json(self._job_dir(job_id) / "mentions.json", artifact.model_dump(mode="json"))
        current = self.get_job(job_id)
        self._update_job(
            job_id,
            artifacts={**current.artifacts, "mentions": True},
            mention_count=len(matches),
        )
        return artifact

    def get_mentions(self, job_id: str) -> MentionArtifact:
        path = self._job_dir(job_id) / "mentions.json"
        if not path.exists():
            return MentionArtifact()
        return MentionArtifact(**self._read_json(path))

    def save_summary(self, job_id: str, summary: dict[str, Any]) -> dict[str, Any]:
        self._write_json(self._job_dir(job_id) / "summary.json", summary)
        current = self.get_job(job_id)
        self._update_job(job_id, artifacts={**current.artifacts, "summary": True})
        return summary

    def get_summary(self, job_id: str) -> dict[str, Any]:
        path = self._job_dir(job_id) / "summary.json"
        if not path.exists():
            return {"items": []}
        return self._read_json(path)

    def save_export_text(self, job_id: str, text: str) -> str:
        self._write_text(self._job_dir(job_id) / "export.txt", text)
        current = self.get_job(job_id)
        self._update_job(job_id, artifacts={**current.artifacts, "export_txt": True})
        return text

    def get_export_text(self, job_id: str) -> str:
        path = self._job_dir(job_id) / "export.txt"
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def _update_job(self, job_id: str, **changes: Any) -> JobRecord:
        record = self.get_job(job_id)
        data = record.model_dump(mode="json")
        data.update(changes)
        data["updated_at"] = _now()
        updated = JobRecord(**data)
        self._save_job(updated)
        return updated

    def _save_job(self, record: JobRecord) -> None:
        self._write_json(self._job_path(record.job_id), record.model_dump(mode="json"))
        index = self._read_index()
        summary = {
            "job_id": record.job_id,
            "status": record.status.value,
            "target": record.target.model_dump(mode="json") if record.target else None,
            "title": record.title,
            "selected_countries": record.selected_countries,
            "detected_language": record.detected_language,
            "artifacts": record.artifacts,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "mention_count": record.mention_count,
        }
        for item_index, item in enumerate(index["items"]):
            if item["job_id"] == record.job_id:
                index["items"][item_index] = summary
                break
        else:
            index["items"].append(summary)
        self._write_json(self.index_path, index)

    def _remove_artifacts(self, job_id: str) -> None:
        for name in ["transcript.json", "mentions.json", "summary.json", "export.txt"]:
            path = self._job_dir(job_id) / name
            if path.exists():
                path.unlink()

    def _remove_generated_job_artifacts(self, job_id: str) -> list[str]:
        job_dir = self._job_dir(job_id)
        removed: list[str] = []
        for path in sorted(job_dir.iterdir(), key=lambda candidate: candidate.name):
            if path.name == "job.json":
                continue
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            removed.append(path.name)
        return removed

    def _delete_job_files(self, job_id: str) -> None:
        job_dir = self._job_dir(job_id)
        if job_dir.exists():
            shutil.rmtree(job_dir)
        index = self._read_index()
        index["items"] = [item for item in index["items"] if item["job_id"] != job_id]
        self._write_json(self.index_path, index)

    def _resolve_linked_cleanup_jobs(
        self, *, job_ids: list[str], urls: list[str], video_ids: list[str]
    ) -> tuple[list[str], list[str], list[dict[str, str]]]:
        index_items = self._read_index()["items"]
        resolved: list[str] = []
        missing: list[str] = []
        errors: list[dict[str, str]] = []

        def add(job_id: str) -> None:
            if job_id not in resolved:
                resolved.append(job_id)

        existing_ids = {str(item["job_id"]) for item in index_items}
        for job_id in job_ids:
            if not JOB_ID_PATTERN.fullmatch(str(job_id)):
                errors.append({"code": "invalid_job_id", "value": str(job_id)})
                continue
            if job_id in existing_ids:
                add(job_id)
            else:
                missing.append(job_id)
        for url in urls:
            matches = [item for item in index_items if self.get_job(str(item["job_id"])).url == url]
            if matches:
                for item in matches:
                    add(str(item["job_id"]))
            else:
                missing.append(url)
        wanted_video_ids = {value.strip() for value in video_ids if value and value.strip()}
        for item in index_items:
            job_id = str(item["job_id"])
            if _youtube_video_id(self.get_job(job_id).url) in wanted_video_ids:
                add(job_id)
        matched_video_ids = {_youtube_video_id(self.get_job(job_id).url) for job_id in resolved}
        for video_id in wanted_video_ids - matched_video_ids:
            missing.append(video_id)
        return resolved, missing, errors

    def _job_dir(self, job_id: str) -> Path:
        if not JOB_ID_PATTERN.fullmatch(job_id):
            raise JobIdError("invalid_job_id", "Job id must be a 32 character lowercase hex value")
        job_dir = (self.jobs_dir / job_id).resolve()
        jobs_root = self.jobs_dir.resolve()
        if job_dir != jobs_root / job_id:
            raise JobIdError("invalid_job_id", "Job id must stay inside the jobs directory")
        return job_dir

    def _job_path(self, job_id: str) -> Path:
        return self._job_dir(job_id) / "job.json"

    def _read_index(self) -> dict[str, Any]:
        return self._read_json(self.index_path)

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise JobNotFoundError("job_not_found", "Job was not found") from exc
        except json.JSONDecodeError as exc:
            raise ArtifactCorruptError("artifact_corrupt", "Stored job artifact is not valid JSON") from exc

    @staticmethod
    def _write_json(path: Path, data: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)
        JobStore._write_text(path, payload)

    @staticmethod
    def _write_text(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            tmp_path.write_text(text, encoding="utf-8")
            os.replace(tmp_path, path)
        except OSError as exc:
            if tmp_path.exists():
                tmp_path.unlink()
            raise ArtifactWriteError("artifact_write_failed", "Could not write job artifact atomically") from exc


def _youtube_video_id(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    host = parsed.netloc.casefold()
    if host.endswith("youtu.be"):
        return parsed.path.strip("/").split("/")[0] or None
    query_id = parse_qs(parsed.query).get("v", [None])[0]
    if query_id:
        return query_id
    return None
