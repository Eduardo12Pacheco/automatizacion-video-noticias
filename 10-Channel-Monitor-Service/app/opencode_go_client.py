from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Protocol


OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1"
OPENCODE_GO_HOST = "opencode.ai"
OPENCODE_GO_PATH = "/zen/go/v1"
OPENCODE_GO_USER_AGENT = "radar-ai-rescue/1.0 (+https://opencode.ai)"


class OpenCodeGoError(RuntimeError):
    def __init__(self, message: str, *, category: str = "unknown", status_code: int | None = None):
        super().__init__(message)
        self.category = category
        self.status_code = status_code


class OpenCodeGoResponse(Protocol):
    status_code: int
    text: str
    headers: Any

    def json(self) -> dict[str, Any]: ...


class OpenCodeGoHttpClient(Protocol):
    def post_json(self, url: str, payload: dict[str, Any], headers: dict[str, str], timeout: int) -> OpenCodeGoResponse: ...


class OpenCodeGoClient:
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str,
        api_keys: list[str] | None = None,
        http: OpenCodeGoHttpClient | None = None,
        timeout_seconds: int = 60,
        clock: Any | None = None,
    ):
        self.base_url = _validated_base_url(base_url)
        self.model = model
        self.api_keys = _normalized_api_keys(api_keys) if api_keys is not None else [api_key.strip()]
        self.http = http or _UrllibJsonHttpClient()
        self.timeout_seconds = timeout_seconds
        self._clock = clock or time.time
        self._next_key_index = 0
        self._cooldown_until: dict[int, float] = {}

    def complete_json(self, prompt: str) -> str:
        if not self.api_keys:
            raise OpenCodeGoError("OpenCode Go API key is not configured", category="auth", status_code=401)
        errors: list[OpenCodeGoError] = []
        for key_index in self._candidate_key_indexes():
            try:
                return self._complete_json_with_key(prompt, key_index=key_index)
            except OpenCodeGoError as exc:
                errors.append(exc)
                if exc.category in {"rate_limited", "server_error", "timeout", "transport", "auth"}:
                    self._cooldown_key(key_index, exc)
                    continue
                raise exc
        if errors:
            if len(errors) == 1:
                raise errors[0]
            raise _combined_error(errors)
        raise OpenCodeGoError("OpenCode Go API key is not configured", category="auth", status_code=401)

    def _complete_json_with_key(self, prompt: str, *, key_index: int) -> str:
        try:
            response = self.http.post_json(
                f"{self.base_url}/chat/completions",
                payload={"model": self.model, "messages": [{"role": "user", "content": prompt}]},
                headers=self._headers(self.api_keys[key_index] if self.api_keys else ""),
                timeout=self.timeout_seconds,
            )
        except urllib.error.HTTPError as exc:
            raise _error_for_status(int(exc.code), _retry_after_seconds(getattr(exc, "headers", None))) from exc
        except json.JSONDecodeError as exc:
            raise OpenCodeGoError("OpenCode Go response invalid JSON", category="invalid_response") from exc
        except TimeoutError as exc:
            raise OpenCodeGoError("OpenCode Go timeout", category="timeout") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise OpenCodeGoError("OpenCode Go transport error", category="transport") from exc
        if not 200 <= int(response.status_code) < 300:
            raise _error_for_status(int(response.status_code), _retry_after_seconds(getattr(response, "headers", None)))
        try:
            payload = response.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise OpenCodeGoError("OpenCode Go response invalid JSON", category="invalid_response") from exc
        content = _extract_openai_content(payload)
        if not isinstance(content, str) or not content.strip():
            raise OpenCodeGoError("OpenCode Go response missing JSON content", category="invalid_response")
        self._next_key_index = (key_index + 1) % max(1, len(self.api_keys))
        return content.strip()

    def _headers(self, api_key: str) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": OPENCODE_GO_USER_AGENT,
        }
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    def _candidate_key_indexes(self) -> list[int]:
        count = len(self.api_keys)
        ordered = [(self._next_key_index + offset) % count for offset in range(count)]
        now = float(self._clock())
        ready = [index for index in ordered if self._cooldown_until.get(index, 0) <= now]
        cooled = [index for index in ordered if index not in ready]
        return ready + cooled

    def _cooldown_key(self, key_index: int, error: OpenCodeGoError) -> None:
        retry_after = getattr(error, "retry_after_seconds", None)
        if retry_after is None:
            retry_after = _default_cooldown_seconds(error.category)
        self._cooldown_until[key_index] = float(self._clock()) + float(retry_after)


def _validated_base_url(base_url: str) -> str:
    parsed = urllib.parse.urlparse(base_url.rstrip("/"))
    if parsed.scheme != "https" or parsed.netloc.casefold() != OPENCODE_GO_HOST or parsed.path.rstrip("/") != OPENCODE_GO_PATH:
        raise OpenCodeGoError("OpenCode Go base URL must be https://opencode.ai/zen/go/v1", category="configuration")
    return parsed.geturl().rstrip("/")


def _normalized_api_keys(api_keys: list[str]) -> list[str]:
    return [key.strip() for key in api_keys if key and key.strip()]


def _error_for_status(status_code: int, retry_after_seconds: int | None = None) -> OpenCodeGoError:
    if status_code == 429:
        category = "rate_limited"
    elif status_code in {401, 403}:
        category = "auth"
    elif 500 <= status_code <= 599:
        category = "server_error"
    else:
        category = "http_error"
    error = OpenCodeGoError(f"OpenCode Go request failed with status {status_code}", category=category, status_code=status_code)
    if retry_after_seconds is not None:
        error.retry_after_seconds = retry_after_seconds
    return error


def _retry_after_seconds(headers: Any) -> int | None:
    if not headers:
        return None
    value = None
    if hasattr(headers, "get"):
        value = headers.get("Retry-After") or headers.get("retry-after")
    if value is None:
        return None
    try:
        return max(1, int(str(value).strip()))
    except ValueError:
        return None


def _default_cooldown_seconds(category: str) -> int:
    if category == "rate_limited":
        return 60
    if category == "auth":
        return 3600
    if category == "server_error":
        return 30
    if category in {"timeout", "transport"}:
        return 10
    return 30


def _combined_error(errors: list[OpenCodeGoError]) -> OpenCodeGoError:
    categories = [error.category for error in errors]
    if all(category == "auth" for category in categories):
        return OpenCodeGoError("OpenCode Go authentication failed for all configured keys", category="auth", status_code=401)
    if any(category == "rate_limited" for category in categories):
        return OpenCodeGoError("OpenCode Go rate limited for all configured keys", category="rate_limited", status_code=429)
    if any(category == "server_error" for category in categories):
        return OpenCodeGoError("OpenCode Go server error for all configured keys", category="server_error")
    if any(category in {"timeout", "transport"} for category in categories):
        return OpenCodeGoError("OpenCode Go transport error for all configured keys", category="transport")
    return errors[-1]


def _extract_openai_content(payload: dict[str, Any]) -> str | None:
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                return message["content"]
            if isinstance(first.get("text"), str):
                return first["text"]
    fallback = payload.get("content") or payload.get("response") or payload.get("text")
    return fallback if isinstance(fallback, str) else None


class _UrllibJsonResponse:
    def __init__(self, status_code: int, text: str, headers: Any = None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}

    def json(self) -> dict[str, Any]:
        return json.loads(self.text)


class _UrllibJsonHttpClient:
    def post_json(self, url: str, payload: dict[str, Any], headers: dict[str, str], timeout: int) -> _UrllibJsonResponse:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return _UrllibJsonResponse(response.status, response.read().decode("utf-8"), response.headers)
