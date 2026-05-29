from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from typing import Protocol
from urllib import error, request


@dataclass(frozen=True)
class RadarJobResult:
    job_id: str
    status: str


class RadarBusy(Exception):
    pass


class RadarServerError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


class HttpResponse(Protocol):
    status_code: int

    def json(self) -> dict: ...


class HttpClient(Protocol):
    def post_json(self, url: str, *, headers: dict[str, str], payload: dict) -> HttpResponse: ...

    def get(self, url: str, *, headers: dict[str, str]) -> HttpResponse: ...


class RadarClient:
    def __init__(self, *, base_url: str, api_key: str, http: HttpClient | None = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.http = http or UrllibHttpClient()

    def submit_job(self, url: str, *, countries: list[str]) -> RadarJobResult:
        response = self.http.post_json(
            f"{self.base_url}/api/radar/jobs",
            headers={"x-api-key": self.api_key},
            payload={"url": url, "countries": countries, "extra_keywords": []},
        )
        if response.status_code == 201:
            body = response.json()
            return RadarJobResult(job_id=str(body["job_id"]), status=str(body["status"]))
        if response.status_code == 409:
            raise RadarBusy("radar_busy")
        if response.status_code >= 500:
            raise RadarServerError(response.status_code, "radar_server_error")
        raise RadarServerError(response.status_code, "radar_rejected_job")

    def get_job_detail(self, job_id: str) -> dict[str, Any]:
        response = self.http.get(f"{self.base_url}/api/radar/jobs/{job_id}", headers={"x-api-key": self.api_key})
        if response.status_code == 200:
            return response.json()
        raise RadarServerError(response.status_code, "radar_job_detail_unavailable")

    def get_job_summary(self, job_id: str) -> dict[str, Any]:
        response = self.http.get(f"{self.base_url}/api/radar/jobs/{job_id}/summary", headers={"x-api-key": self.api_key})
        if response.status_code == 200:
            return response.json()
        raise RadarServerError(response.status_code, "radar_job_summary_unavailable")

    def preflight(self) -> dict[str, Any]:
        url_configured = bool(self.base_url)
        api_key_configured = bool(self.api_key)
        base = {"url_configured": url_configured, "api_key_configured": api_key_configured}
        if not url_configured or not api_key_configured:
            missing = []
            if not url_configured:
                missing.append("URL")
            if not api_key_configured:
                missing.append("API key")
            return {
                "status": "failed",
                "code": "radar_config_missing",
                **base,
                "message": f"Radar {' and '.join(missing)} {'are' if len(missing) > 1 else 'is'} required",
            }
        try:
            response = self.http.get(f"{self.base_url}/api/radar/health", headers={"x-api-key": self.api_key})
        except Exception:
            return {"status": "degraded", "code": "radar_unreachable", **base, "message": "Radar health check failed"}
        if response.status_code == 200:
            return {"status": "ready", "code": "radar_reachable", **base, "http_status": 200}
        if response.status_code in {401, 403}:
            return {"status": "failed", "code": "radar_unauthorized", **base, "http_status": response.status_code}
        return {"status": "degraded", "code": "radar_unreachable", **base, "http_status": response.status_code}


class UrllibHttpResponse:
    def __init__(self, *, status_code: int, body: bytes):
        self.status_code = status_code
        self._body = body

    def json(self) -> dict:
        if not self._body:
            return {}
        return json.loads(self._body.decode("utf-8"))


class UrllibHttpClient:
    def get(self, url: str, *, headers: dict[str, str]) -> UrllibHttpResponse:
        req = request.Request(url, method="GET", headers=headers)
        try:
            with request.urlopen(req, timeout=5) as response:
                return UrllibHttpResponse(status_code=int(response.status), body=response.read())
        except error.HTTPError as exc:
            return UrllibHttpResponse(status_code=int(exc.code), body=exc.read())

    def post_json(self, url: str, *, headers: dict[str, str], payload: dict) -> UrllibHttpResponse:
        body = json.dumps(payload).encode("utf-8")
        req = request.Request(
            url,
            data=body,
            method="POST",
            headers=headers | {"content-type": "application/json"},
        )
        try:
            with request.urlopen(req, timeout=10) as response:
                return UrllibHttpResponse(status_code=int(response.status), body=response.read())
        except error.HTTPError as exc:
            return UrllibHttpResponse(status_code=int(exc.code), body=exc.read())
