from __future__ import annotations

import json
import urllib.error

from app.opencode_go_client import OpenCodeGoClient, OpenCodeGoError


class FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200, headers: dict | None = None):
        self._payload = payload
        self.status_code = status_code
        self.text = str(payload)
        self.headers = headers or {}

    def json(self) -> dict:
        return self._payload


class FakeHttp:
    def __init__(self, response: FakeResponse):
        self.response = response
        self.posts: list[tuple[str, dict, dict, int]] = []

    def post_json(self, url: str, payload: dict, headers: dict[str, str], timeout: int):
        self.posts.append((url, payload, headers, timeout))
        return self.response


class RaisingHttp:
    def __init__(self, error: Exception):
        self.error = error

    def post_json(self, url: str, payload: dict, headers: dict[str, str], timeout: int):
        raise self.error


class SequenceHttp:
    def __init__(self, responses: list[FakeResponse | Exception]):
        self.responses = responses
        self.posts: list[tuple[str, dict, dict, int]] = []

    def post_json(self, url: str, payload: dict, headers: dict[str, str], timeout: int):
        self.posts.append((url, payload, headers, timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def test_opencode_go_client_posts_prompt_with_server_auth_model_and_timeout():
    http = FakeHttp(
        FakeResponse(
            {"choices": [{"message": {"content": '{"candidates":[],"rejections":[]}'}}]}
        )
    )
    client = OpenCodeGoClient(
        base_url="https://opencode.ai/zen/go/v1/",
        model="radar-model",
        api_key="server-secret",
        http=http,
        timeout_seconds=17,
    )

    result = client.complete_json("Return strict JSON only")

    assert result == '{"candidates":[],"rejections":[]}'
    assert http.posts == [
        (
            "https://opencode.ai/zen/go/v1/chat/completions",
            {"model": "radar-model", "messages": [{"role": "user", "content": "Return strict JSON only"}]},
            {
                "Authorization": "Bearer server-secret",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "radar-ai-rescue/1.0 (+https://opencode.ai)",
            },
            17,
        )
    ]


def test_opencode_go_client_rejects_http_errors_and_missing_json_content_without_real_calls():
    failing = OpenCodeGoClient(base_url="https://opencode.ai/zen/go/v1", model="m", api_key="", http=FakeHttp(FakeResponse({}, 500)))

    try:
        failing.complete_json("prompt")
    except OpenCodeGoError as exc:
        assert "500" in str(exc)
    else:
        raise AssertionError("expected OpenCodeGoError")

    missing = OpenCodeGoClient(base_url="https://opencode.ai/zen/go/v1", model="m", api_key="", http=FakeHttp(FakeResponse({"ok": True})))
    try:
        missing.complete_json("prompt")
    except OpenCodeGoError as exc:
        assert "content" in str(exc)
    else:
        raise AssertionError("expected OpenCodeGoError")


def test_opencode_go_client_sends_stable_json_headers_without_optional_auth():
    http = FakeHttp(FakeResponse({"content": '{"candidates":[],"rejections":[]}'}))
    client = OpenCodeGoClient(
        base_url="https://opencode.ai/zen/go/v1",
        model="m",
        api_key="",
        http=http,
    )

    client.complete_json("prompt")

    _, _, headers, _ = http.posts[0]
    assert headers["Accept"] == "application/json"
    assert headers["Content-Type"] == "application/json"
    assert headers["User-Agent"].strip()
    assert "Authorization" not in headers


def test_opencode_go_client_keeps_legacy_content_fallback_but_rejects_ssrf_base_urls():
    fallback_http = FakeHttp(FakeResponse({"content": '{"candidates":[1],"rejections":[]}'}))
    client = OpenCodeGoClient(
        base_url="https://opencode.ai/zen/go/v1",
        model="m",
        api_key="",
        http=fallback_http,
    )

    assert client.complete_json("prompt") == '{"candidates":[1],"rejections":[]}'

    for unsafe_url in ["http://opencode.ai/zen/go/v1", "https://evil.test/zen/go/v1", "https://opencode.ai/admin"]:
        try:
            OpenCodeGoClient(base_url=unsafe_url, model="m", api_key="", http=fallback_http)
        except OpenCodeGoError as exc:
            assert "base URL" in str(exc)
        else:
            raise AssertionError(f"expected unsafe base URL to be rejected: {unsafe_url}")


def test_opencode_go_client_normalizes_transport_and_json_errors_without_request_details():
    cases = [
        (urllib.error.URLError("timed out contacting https://opencode.ai/zen/go/v1/chat/completions?token=secret"), "transport"),
        (urllib.error.HTTPError("https://opencode.ai/secret", 401, "Unauthorized secret", {}, None), "status 401"),
        (json.JSONDecodeError("bad token secret", "not-json", 0), "invalid JSON"),
    ]

    for error, expected in cases:
        client = OpenCodeGoClient(
            base_url="https://opencode.ai/zen/go/v1",
            model="m",
            api_key="server-secret",
            http=RaisingHttp(error),
        )
        try:
            client.complete_json("prompt")
        except OpenCodeGoError as exc:
            message = str(exc)
            assert expected in message
            assert "server-secret" not in message
            assert "token=secret" not in message
            assert "https://opencode.ai/secret" not in message
        else:
            raise AssertionError(f"expected OpenCodeGoError for {error!r}")


def test_opencode_go_client_uses_multiple_keys_round_robin_without_leaking_values():
    http = SequenceHttp(
        [
            FakeResponse({"content": '{"call":1}'}),
            FakeResponse({"content": '{"call":2}'}),
        ]
    )
    client = OpenCodeGoClient(
        base_url="https://opencode.ai/zen/go/v1",
        model="m",
        api_key="legacy-secret",
        api_keys=["key-one", "key-two"],
        http=http,
    )

    assert client.complete_json("prompt") == '{"call":1}'
    assert client.complete_json("prompt") == '{"call":2}'

    assert http.posts[0][2]["Authorization"] == "Bearer key-one"
    assert http.posts[1][2]["Authorization"] == "Bearer key-two"


def test_opencode_go_client_falls_back_on_rate_limit_server_and_timeout_errors():
    for first_failure in [
        FakeResponse({}, 429, headers={"Retry-After": "5"}),
        FakeResponse({}, 503),
        TimeoutError("secret timeout"),
    ]:
        http = SequenceHttp([first_failure, FakeResponse({"content": '{"ok":true}'})])
        client = OpenCodeGoClient(
            base_url="https://opencode.ai/zen/go/v1",
            model="m",
            api_key="",
            api_keys=["primary-secret", "backup-secret"],
            http=http,
        )

        assert client.complete_json("prompt") == '{"ok":true}'
        assert http.posts[0][2]["Authorization"] == "Bearer primary-secret"
        assert http.posts[1][2]["Authorization"] == "Bearer backup-secret"


def test_opencode_go_client_skips_cooled_key_until_recovered():
    now = [1000.0]
    http = SequenceHttp(
        [
            FakeResponse({}, 429, headers={"Retry-After": "10"}),
            FakeResponse({"content": '{"backup":true}'}),
            FakeResponse({"content": '{"backup_again":true}'}),
            FakeResponse({"content": '{"primary_recovered":true}'}),
        ]
    )
    client = OpenCodeGoClient(
        base_url="https://opencode.ai/zen/go/v1",
        model="m",
        api_key="",
        api_keys=["primary-secret", "backup-secret"],
        http=http,
        clock=lambda: now[0],
    )

    assert client.complete_json("prompt") == '{"backup":true}'
    assert client.complete_json("prompt") == '{"backup_again":true}'
    now[0] = 1011.0
    assert client.complete_json("prompt") == '{"primary_recovered":true}'

    assert [post[2]["Authorization"] for post in http.posts] == [
        "Bearer primary-secret",
        "Bearer backup-secret",
        "Bearer backup-secret",
        "Bearer primary-secret",
    ]


def test_opencode_go_client_all_keys_fail_with_sanitized_error():
    http = SequenceHttp([FakeResponse({}, 401), FakeResponse({}, 403)])
    client = OpenCodeGoClient(
        base_url="https://opencode.ai/zen/go/v1",
        model="m",
        api_key="",
        api_keys=["primary-secret", "backup-secret"],
        http=http,
    )

    try:
        client.complete_json("prompt")
    except OpenCodeGoError as exc:
        assert exc.category == "auth"
        assert "primary-secret" not in str(exc)
        assert "backup-secret" not in str(exc)
    else:
        raise AssertionError("expected OpenCodeGoError")
