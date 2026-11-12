from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    CANCEL_REQUESTED = "cancel_requested"
    DELETE_REQUESTED = "delete_requested"
    DELETED = "deleted"


class TargetProfile(BaseModel):
    type: Literal["country", "player"]
    name: str
    aliases: list[str] = Field(default_factory=list)


class JobCreateRequest(BaseModel):
    url: str
    countries: list[str] = Field(default_factory=list)
    target: TargetProfile | None = None
    extra_keywords: list[str] = Field(default_factory=list)


class JobCreateResponse(BaseModel):
    job_id: str
    status: JobStatus


class TranscriptSegment(BaseModel):
    id: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    text: str


class TranscribeRequest(BaseModel):
    audio_path: str
    language: str | None = None


class DownloadRequest(BaseModel):
    url: str
    job_dir: str | None = None


class DownloadResponse(BaseModel):
    path: str
    title: str | None = None


class TranscribeResponse(BaseModel):
    segments: list[TranscriptSegment] = Field(default_factory=list)
    language: str | None = None
    device: str | None = None
    fallback_used: bool = False


class TranscriptArtifact(BaseModel):
    segments: list[TranscriptSegment] = Field(default_factory=list)
    text: str = ""
    detected_language: str | None = None


class MentionMatch(BaseModel):
    keyword: str
    canonical: str
    country: str | None = None
    segment_id: str
    start_ms: int
    end_ms: int
    text: str
    context_before: str | None = None
    context_after: str | None = None


class MentionArtifact(BaseModel):
    matches: list[MentionMatch] = Field(default_factory=list)
    detected_language: str | None = None


class JobRecord(BaseModel):
    job_id: str
    url: str
    target: TargetProfile | None = None
    selected_countries: list[str] = Field(default_factory=list)
    extra_keywords: list[str] = Field(default_factory=list)
    status: JobStatus
    created_at: str
    updated_at: str
    progress: int = 0
    error: dict[str, str] | None = None
    stage: str = "queued"
    title: str | None = None
    detected_language: str | None = None
    variants_used: dict[str, list[str]] = Field(default_factory=dict)
    delete_requested: bool = False
    artifacts: dict[str, bool] = Field(default_factory=lambda: {"transcript": False, "mentions": False, "summary": False, "export_txt": False})
    mention_count: int = 0


class HistoryItem(BaseModel):
    job_id: str
    status: JobStatus
    target: TargetProfile | None = None
    title: str | None = None
    selected_countries: list[str] = Field(default_factory=list)
    detected_language: str | None = None
    artifacts: dict[str, bool] = Field(default_factory=dict)
    created_at: str
    updated_at: str
    mention_count: int = 0


class HistoryResponse(BaseModel):
    items: list[HistoryItem]


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    worker: dict[str, int | bool]
    runtime: dict[str, Any]
    failures: list[dict[str, str]] = Field(default_factory=list)
