from __future__ import annotations

import hmac
from typing import Callable

from subtitles_service.domain.errors import ErrorCode, PipelineError


def validate_voice_style_auth(
    x_api_key: str | None,
    authorization: str | None,
    api_key: str,
    basic_user: str,
    basic_pass: str,
) -> str:
    """Validate authentication for voice style API.

    Returns user email on success, raises PipelineError on failure.
    """
    # Check API key
    if x_api_key and _secure_compare(x_api_key, api_key):
        return "api-key-user"

    # Check Basic auth
    if authorization and authorization.startswith("Basic "):
        try:
            import base64
            decoded = base64.b64decode(authorization[6:]).decode("utf-8")
            user, password = decoded.split(":", 1)
            if _secure_compare(user, basic_user) and _secure_compare(password, basic_pass):
                return user
        except Exception:
            pass

    raise PipelineError(
        code=ErrorCode.AUTH_REQUIRED,
        message="Authentication required",
        details={},
    )


def _secure_compare(a: str, b: str) -> bool:
    """Secure string comparison to prevent timing attacks."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))
