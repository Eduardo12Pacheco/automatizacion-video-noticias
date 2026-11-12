from __future__ import annotations

from pathlib import Path

from app.preflight import PreflightChecker, collect_preflight_failures
from app.settings import Settings


def _settings(**overrides) -> Settings:
    values = {"api_key": "test-key", "runtime_dir": Path("runtime"), "media_url_dns_check": False}
    values.update(overrides)
    return Settings(**values)


def test_preflight_local_mode_preserves_yt_dlp_dependency_check(monkeypatch):
    which_calls: list[str] = []

    def fake_which(binary: str):
        which_calls.append(binary)
        return f"C:/bin/{binary}.exe"

    monkeypatch.setattr("app.preflight.shutil.which", fake_which)
    monkeypatch.setattr("app.preflight.importlib.util.find_spec", lambda name: object())

    report = PreflightChecker(_settings(yt_dlp_binary="yt-dlp-custom")).report()

    assert which_calls == ["ffmpeg", "yt-dlp-custom"]
    assert report["yt_dlp"] == {"status": "ok", "path": "C:/bin/yt-dlp-custom.exe"}
    assert collect_preflight_failures(report) == []
