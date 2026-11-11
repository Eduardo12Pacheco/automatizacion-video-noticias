from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Mapping

from .errors import BoundaryProviderError


class UrllibJsonHttpClient:
    def __init__(self, *, timeout_seconds: float = 10.0):
        self.timeout_seconds = timeout_seconds

    def get_json(self, url: str, params: Mapping[str, Any]) -> dict[str, Any]:
        query = urllib.parse.urlencode({key: value for key, value in params.items() if value is not None})
        request_url = f"{url}?{query}"
        request = urllib.request.Request(request_url, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310 - explicit Data API URL only.
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raise _map_http_error(exc) from exc
        except urllib.error.URLError as exc:
            raise BoundaryProviderError("boundary_upstream_failed", "YouTube Data API request failed", retryable=True, status=502) from exc
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError as exc:
            raise BoundaryProviderError("boundary_upstream_failed", "YouTube Data API returned invalid JSON", retryable=True, status=502) from exc
        if not isinstance(parsed, dict):
            raise BoundaryProviderError("boundary_upstream_failed", "YouTube Data API returned invalid JSON", retryable=True, status=502)
        return parsed

    def get_text(self, url: str, params: Mapping[str, Any]) -> str:
        query = urllib.parse.urlencode({key: value for key, value in params.items() if value is not None})
        request_url = f"{url}?{query}"
        request = urllib.request.Request(request_url, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310 - explicit timedtext URL only.
                return response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raise _map_http_error(exc) from exc
        except urllib.error.URLError as exc:
            raise BoundaryProviderError("boundary_upstream_failed", "YouTube timedtext request failed", retryable=True, status=502) from exc

    def post_form(self, url: str, data: Mapping[str, Any]) -> dict[str, Any]:
        encoded = urllib.parse.urlencode({key: value for key, value in data.items() if value is not None}).encode("utf-8")
        request = urllib.request.Request(url, data=encoded, headers={"content-type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310 - explicit WebSub hub URL only.
                return {"status_code": int(response.status)}
        except urllib.error.HTTPError as exc:
            return {"status_code": int(exc.code)}
        except urllib.error.URLError as exc:
            raise BoundaryProviderError("websub_hub_rejected", "YouTube WebSub hub request failed", retryable=True, status=502) from exc


def _map_http_error(error: urllib.error.HTTPError) -> BoundaryProviderError:
    code = "boundary_upstream_failed"
    message = "YouTube Data API request failed"
    retryable = 500 <= int(error.code) < 600
    status = 502 if retryable else int(error.code)
    try:
        body = error.read().decode("utf-8")
        parsed = json.loads(body) if body else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        parsed = {}
    reason = ""
    if isinstance(parsed, dict):
        errors = parsed.get("error", {}).get("errors", []) if isinstance(parsed.get("error"), dict) else []
        first = errors[0] if errors and isinstance(errors[0], dict) else {}
        reason = str(first.get("reason") or "")
    if int(error.code) == 403 and reason in {"quotaExceeded", "dailyLimitExceeded", "userRateLimitExceeded"}:
        code = "youtube_quota_exceeded"
        message = "YouTube Data API quota exceeded"
        retryable = True
        status = 429
    elif int(error.code) == 404:
        code = "youtube_not_found"
        message = "YouTube resource not found"
        retryable = False
        status = 404
    return BoundaryProviderError(code, message, retryable=retryable, status=status)
