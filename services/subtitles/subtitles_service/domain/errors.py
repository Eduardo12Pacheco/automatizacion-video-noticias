from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class ErrorCode(str, Enum):
    AUTH_REQUIRED = "auth_required"
    INPUT_CONTRACT_VIOLATION = "input_contract_violation"
    VIDEO_INPUT_CONTRACT_VIOLATION = "video_input_contract_violation"
    SESSION_NOT_FOUND = "session_not_found"
    SNAPSHOT_VERSION_CONFLICT = "snapshot_version_conflict"
    RENDER_NOT_READY = "render_not_ready"
    EXECUTABLE_NOT_FOUND = "executable_not_found"
    MODEL_NOT_AVAILABLE = "model_not_available"
    ASR_FAILED = "asr_failed"
    TRANSLATION_FAILED = "translation_failed"
    EDIT_SAVE_FAILED = "edit_save_failed"
    JSON_CONTRACT_VIOLATION = "json_contract_violation"
    STYLE_CONTRACT_VIOLATION = "style_contract_violation"
    NVENC_REQUIRED_UNAVAILABLE = "nvenc_required_unavailable"
    RENDER_FAILED = "render_failed"
    DURATION_MISMATCH = "duration_mismatch"
    ARTIFACT_VALIDATION_FAILED = "artifact_validation_failed"
    UNSUPPORTED_SOURCE_LANGUAGE = "unsupported_source_language"
    UNSUPPORTED_DETECTED_LANGUAGE = "unsupported_detected_language"
    M2M100_MODEL_NOT_FOUND = "m2m100_model_not_found"


EXIT_CODES = {
    ErrorCode.AUTH_REQUIRED: 2,
    ErrorCode.INPUT_CONTRACT_VIOLATION: 2,
    ErrorCode.VIDEO_INPUT_CONTRACT_VIOLATION: 2,
    ErrorCode.SESSION_NOT_FOUND: 3,
    ErrorCode.SNAPSHOT_VERSION_CONFLICT: 4,
    ErrorCode.RENDER_NOT_READY: 5,
    ErrorCode.EXECUTABLE_NOT_FOUND: 6,
    ErrorCode.MODEL_NOT_AVAILABLE: 7,
    ErrorCode.ASR_FAILED: 8,
    ErrorCode.TRANSLATION_FAILED: 9,
    ErrorCode.EDIT_SAVE_FAILED: 10,
    ErrorCode.JSON_CONTRACT_VIOLATION: 11,
    ErrorCode.STYLE_CONTRACT_VIOLATION: 11,
    ErrorCode.NVENC_REQUIRED_UNAVAILABLE: 11,
    ErrorCode.RENDER_FAILED: 11,
    ErrorCode.DURATION_MISMATCH: 11,
    ErrorCode.    ARTIFACT_VALIDATION_FAILED: 11,
    ErrorCode.UNSUPPORTED_SOURCE_LANGUAGE: 2,
    ErrorCode.UNSUPPORTED_DETECTED_LANGUAGE: 2,
    ErrorCode.M2M100_MODEL_NOT_FOUND: 7,
}


@dataclass
class PipelineError(Exception):
    code: ErrorCode
    message: str
    details: dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        return f"{self.code.value}: {self.message}"

    @property
    def exit_code(self) -> int:
        return EXIT_CODES.get(self.code, 1)

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code.value, "message": self.message, "details": self.details}


def map_missing_executable(executable: str) -> PipelineError:
    return PipelineError(
        ErrorCode.EXECUTABLE_NOT_FOUND,
        f"Missing executable: {executable}",
        {"executable": executable},
    )


def map_os_error_to_pipeline_error(error: OSError, executable: str) -> PipelineError:
    errno_value = getattr(error, "errno", None)
    winerror = getattr(error, "winerror", None)
    if errno_value == 2 or winerror == 2:
        return map_missing_executable(executable=executable)
    return PipelineError(
        ErrorCode.ARTIFACT_VALIDATION_FAILED,
        str(error),
        {"executable": executable, "errno": errno_value, "winerror": winerror},
    )


__all__ = ["ErrorCode", "PipelineError", "map_missing_executable", "map_os_error_to_pipeline_error"]
