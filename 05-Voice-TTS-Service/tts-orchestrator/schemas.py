from __future__ import annotations

from pydantic import BaseModel, Field


class CreatePublicJobRequest(BaseModel):
    text: str = Field(min_length=20, max_length=6000)
    title: str | None = Field(default=None, max_length=180)
    request_id: str | None = Field(default=None, max_length=120)
    voice_profile: str = Field(default="default")


class CreatePublicJobResponse(BaseModel):
    job_id: str
    status: str
    position: int | None = None
    eta_seconds: int | None = None
    created_at: str | None = None


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict | None = None


class ErrorEnvelope(BaseModel):
    error: ErrorBody
