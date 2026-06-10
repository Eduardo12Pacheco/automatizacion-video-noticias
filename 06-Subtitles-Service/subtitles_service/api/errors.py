from __future__ import annotations

from fastapi import HTTPException

from subtitles_service.domain.errors import ErrorCode, PipelineError


def http_error(error: Exception) -> HTTPException:
    """Convert PipelineError to HTTPException."""
    if isinstance(error, PipelineError):
        status_code = _map_error_code_to_status(error.code)
        return HTTPException(
            status_code=status_code,
            detail=error.to_dict(),
        )

    # Generic error
    return HTTPException(
        status_code=500,
        detail={
            "code": "internal_error",
            "message": str(error),
        },
    )


def _map_error_code_to_status(code: ErrorCode) -> int:
    """Map error code to HTTP status code."""
    mapping = {
        ErrorCode.AUTH_REQUIRED: 401,
        ErrorCode.INPUT_CONTRACT_VIOLATION: 400,
        ErrorCode.VIDEO_INPUT_CONTRACT_VIOLATION: 400,
        ErrorCode.SESSION_NOT_FOUND: 404,
        ErrorCode.SNAPSHOT_VERSION_CONFLICT: 409,
        ErrorCode.RENDER_NOT_READY: 400,
        ErrorCode.EXECUTABLE_NOT_FOUND: 500,
        ErrorCode.MODEL_NOT_AVAILABLE: 503,
        ErrorCode.ASR_FAILED: 500,
        ErrorCode.TRANSLATION_FAILED: 500,
        ErrorCode.EDIT_SAVE_FAILED: 500,
        ErrorCode.JSON_CONTRACT_VIOLATION: 400,
        ErrorCode.STYLE_CONTRACT_VIOLATION: 400,
        ErrorCode.NVENC_REQUIRED_UNAVAILABLE: 503,
        ErrorCode.RENDER_FAILED: 500,
        ErrorCode.DURATION_MISMATCH: 400,
        ErrorCode.ARTIFACT_VALIDATION_FAILED: 500,
    }
    return mapping.get(code, 500)
