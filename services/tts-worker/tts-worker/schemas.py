from __future__ import annotations

from pydantic import BaseModel, Field


class CreateJobRequest(BaseModel):
    job_id: str = Field(min_length=3, max_length=120)
    text: str = Field(min_length=20, max_length=6000)
    voice_profile: str = Field(default="balanced_default", max_length=64)
    requested_by: str | None = Field(default=None, max_length=320)


class JobResponse(BaseModel):
    job_id: str
    status: str


class JobDetailResponse(BaseModel):
    job_id: str
    status: str
    progress: dict
    created_at: str
    started_at: str | None
    finished_at: str | None
    error: dict | None
