from __future__ import annotations

import json

import pytest

from app.radar_client import RadarBusy, RadarClient, RadarServerError


class FakeHttpResponse:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self.body = body or {}

    def json(self):
        return self.body


class FakeHttpClient:
    def __init__(self, response: FakeHttpResponse | list[FakeHttpResponse]):
        self.responses = response if isinstance(response, list) else [response]
        self.calls: list[dict] = []

    def _next_response(self):
        if len(self.responses) == 1:
            return self.responses[0]
        return self.responses.pop(0)

    def post_json(self, url: str, *, headers: dict[str, str], payload: dict):
        self.calls.append({"url": url, "headers": headers, "payload": payload})
        return self._next_response()

    def get(self, url: str, *, headers: dict[str, str]):
        self.calls.append({"method": "GET", "url": url, "headers": headers})
        return self._next_response()


def test_radar_client_posts_authenticated_job_and_returns_job_id():
    http = FakeHttpClient(FakeHttpResponse(201, {"job_id": "radar-job-1", "status": "queued"}))
    client = RadarClient(base_url="http://127.0.0.1:8765/", api_key="radar-secret", http=http)

    result = client.submit_job("https://www.youtube.com/watch?v=abc123", countries=["fr", "ar"])

    assert result.job_id == "radar-job-1"
    assert http.calls == [
        {
            "url": "http://127.0.0.1:8765/api/radar/jobs",
            "headers": {"x-api-key": "radar-secret"},
            "payload": {"url": "https://www.youtube.com/watch?v=abc123", "countries": ["fr", "ar"], "extra_keywords": []},
        }
    ]
    assert "radar-secret" not in json.dumps(result.__dict__)


def test_radar_client_maps_busy_and_server_errors_to_typed_exceptions():
    busy = RadarClient(base_url="http://radar.local", api_key="secret", http=FakeHttpClient(FakeHttpResponse(409)))
    broken = RadarClient(base_url="http://radar.local", api_key="secret", http=FakeHttpClient(FakeHttpResponse(503)))

    with pytest.raises(RadarBusy):
        busy.submit_job("https://www.youtube.com/watch?v=busy", countries=["fr"])
    with pytest.raises(RadarServerError) as exc:
        broken.submit_job("https://www.youtube.com/watch?v=retry", countries=["fr"])

    assert exc.value.status_code == 503


def test_radar_client_fetches_authenticated_job_detail_and_summary_without_secret_in_results():
    http = FakeHttpClient(
        [
            FakeHttpResponse(200, {"job_id": "job-1", "status": "succeeded"}),
            FakeHttpResponse(200, {"items": [{"label": "Ecuador", "count": 2}, {"label": "Zero", "count": 0}]}),
        ]
    )
    client = RadarClient(base_url="http://radar.local/", api_key="radar-secret", http=http)

    detail = client.get_job_detail("job-1")
    summary = client.get_job_summary("job-1")

    assert detail == {"job_id": "job-1", "status": "succeeded"}
    assert summary == {"items": [{"label": "Ecuador", "count": 2}, {"label": "Zero", "count": 0}]}
    assert http.calls == [
        {"method": "GET", "url": "http://radar.local/api/radar/jobs/job-1", "headers": {"x-api-key": "radar-secret"}},
        {
            "method": "GET",
            "url": "http://radar.local/api/radar/jobs/job-1/summary",
            "headers": {"x-api-key": "radar-secret"},
        },
    ]
    assert "radar-secret" not in json.dumps(detail | summary)


def test_radar_client_fetches_authenticated_transcript_without_secret_in_result():
    http = FakeHttpClient(FakeHttpResponse(200, {"segments": [{"start_ms": 0, "end_ms": 1000, "text": "gol"}]}))
    client = RadarClient(base_url="http://radar.local/", api_key="radar-secret", http=http)

    transcript = client.get_job_transcript("job-1")

    assert transcript == {"segments": [{"start_ms": 0, "end_ms": 1000, "text": "gol"}]}
    assert http.calls == [
        {"method": "GET", "url": "http://radar.local/api/radar/jobs/job-1/transcript", "headers": {"x-api-key": "radar-secret"}}
    ]
    assert "radar-secret" not in json.dumps(transcript)


def test_radar_preflight_uses_authenticated_health_get_without_secret_in_result():
    http = FakeHttpClient(FakeHttpResponse(200, {"status": "ok"}))
    client = RadarClient(base_url="http://radar.local/", api_key="radar-secret", http=http)

    result = client.preflight()

    assert http.calls == [
        {"method": "GET", "url": "http://radar.local/api/radar/health", "headers": {"x-api-key": "radar-secret"}}
    ]
    assert result == {
        "status": "ready",
        "code": "radar_reachable",
        "url_configured": True,
        "api_key_configured": True,
        "http_status": 200,
    }
    assert "radar-secret" not in json.dumps(result)


@pytest.mark.parametrize(
    ("status_code", "expected_status", "expected_code"),
    [(401, "failed", "radar_unauthorized"), (503, "degraded", "radar_unreachable")],
)
def test_radar_preflight_maps_auth_and_service_failures(status_code, expected_status, expected_code):
    client = RadarClient(base_url="http://radar.local", api_key="secret", http=FakeHttpClient(FakeHttpResponse(status_code)))

    result = client.preflight()

    assert result["status"] == expected_status
    assert result["code"] == expected_code
    assert result["http_status"] == status_code


def test_radar_preflight_reports_missing_config_without_http_call():
    http = FakeHttpClient(FakeHttpResponse(200))
    client = RadarClient(base_url="", api_key="", http=http)

    result = client.preflight()

    assert result == {
        "status": "failed",
        "code": "radar_config_missing",
        "url_configured": False,
        "api_key_configured": False,
        "message": "Radar URL and API key are required",
    }
    assert http.calls == []


def test_radar_preflight_redacts_network_errors():
    class BrokenHttpClient:
        def get(self, url: str, *, headers: dict[str, str]):
            raise OSError("connection refused with radar-secret")

        def post_json(self, url: str, *, headers: dict[str, str], payload: dict):
            raise AssertionError("preflight must not post jobs")

    client = RadarClient(base_url="http://radar.local", api_key="radar-secret", http=BrokenHttpClient())

    result = client.preflight()

    assert result["status"] == "degraded"
    assert result["code"] == "radar_unreachable"
    assert "radar-secret" not in json.dumps(result)
