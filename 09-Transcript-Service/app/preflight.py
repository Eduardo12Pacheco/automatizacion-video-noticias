from __future__ import annotations

import importlib.util
import shutil
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

from .settings import Settings


def collect_preflight_failures(runtime: dict[str, Any]) -> list[dict[str, str]]:
    failures: list[dict[str, str]] = []
    for dependency, detail in runtime.items():
        if isinstance(detail, dict) and detail.get("status") != "ok":
            status = str(detail.get("status") or "")
            if dependency == "remote_fetcher" and status:
                failures.append(
                    {
                        "code": "remote_fetcher_config_missing" if status == "config_missing" else status,
                        "dependency": dependency,
                        "message": str(detail.get("message") or "Remote fetcher preflight failed"),
                    }
                )
                continue
            failures.append(
                {
                    "code": "dependency_missing",
                    "dependency": dependency,
                    "message": f"Required dependency {dependency} is missing",
                }
            )
    return failures


class PreflightChecker:
    def __init__(self, settings: Settings, *, remote_opener=None, remote_timeout_seconds: int = 3):
        self.settings = settings
        self.remote_opener = remote_opener or urlopen
        self.remote_timeout_seconds = remote_timeout_seconds

    def _remote_fetcher_report(self) -> dict[str, str]:
        if not self.settings.transcript_remote_fetcher_url:
            return {
                "status": "config_missing",
                "message": "TRANSCRIPT_REMOTE_FETCHER_URL is required when TRANSCRIPT_FETCH_MODE=remote_only",
            }
        if not self.settings.transcript_remote_fetcher_token:
            return {
                "status": "config_missing",
                "message": "TRANSCRIPT_REMOTE_FETCHER_TOKEN is required when TRANSCRIPT_FETCH_MODE=remote_only",
            }

        parsed_remote_url = urlparse(self.settings.transcript_remote_fetcher_url)
        if parsed_remote_url.scheme not in {"http", "https"} or not parsed_remote_url.netloc:
            return {
                "status": "remote_fetcher_config_invalid",
                "message": "TRANSCRIPT_REMOTE_FETCHER_URL must be an absolute http(s) URL with a host",
            }

        health_url = urljoin(f"{self.settings.transcript_remote_fetcher_url.rstrip('/')}/", "health")
        request = Request(health_url, method="GET")
        try:
            response = self.remote_opener(request, timeout=self.remote_timeout_seconds)
            with response:
                status = int(getattr(response, "status", getattr(response, "code", 200)) or 200)
                if status < 200 or status >= 300:
                    return {
                        "status": "remote_fetcher_health_non_ok",
                        "health_url": health_url,
                        "message": f"Remote fetcher health returned HTTP {status}",
                    }
        except HTTPError as exc:
            return {
                "status": "remote_fetcher_health_non_ok",
                "health_url": health_url,
                "message": f"Remote fetcher health returned HTTP {int(exc.code)}",
            }
        except TimeoutError:
            return {
                "status": "remote_fetcher_health_unavailable",
                "health_url": health_url,
                "message": f"Remote fetcher health timed out after {self.remote_timeout_seconds} seconds",
            }
        except URLError:
            return {
                "status": "remote_fetcher_health_unavailable",
                "health_url": health_url,
                "message": "Remote fetcher health is unavailable",
            }
        return {"status": "ok", "health_url": health_url}

    def report(self) -> dict[str, Any]:
        ffmpeg_path = shutil.which(self.settings.ffmpeg_binary)
        has_faster_whisper = importlib.util.find_spec("faster_whisper") is not None
        faster_whisper = {
            "status": "ok" if has_faster_whisper else "missing",
            "model": self.settings.whisper_model,
            "model_path": self.settings.whisper_model_path,
            "device": self.settings.device,
            "compute_type": self.settings.compute_type,
        }
        mode = (self.settings.transcript_fetch_mode or "local").strip().casefold()
        if mode == "remote_only":
            return {
                "ffmpeg": {"status": "ok" if ffmpeg_path else "missing", "path": ffmpeg_path},
                "remote_fetcher": self._remote_fetcher_report(),
                "faster_whisper": faster_whisper,
            }
        yt_dlp_path = shutil.which(self.settings.yt_dlp_binary)
        return {
            "ffmpeg": {"status": "ok" if ffmpeg_path else "missing", "path": ffmpeg_path},
            "yt_dlp": {"status": "ok" if yt_dlp_path else "missing", "path": yt_dlp_path},
            "faster_whisper": faster_whisper,
        }
