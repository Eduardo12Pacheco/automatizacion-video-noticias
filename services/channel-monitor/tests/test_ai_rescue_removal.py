from __future__ import annotations

import sqlite3
import inspect

import pytest
import app.main as monitor_main
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings, load_settings
from app.store import MonitorStore


def test_ai_rescue_api_routes_are_physically_removed(tmp_path):
    settings = Settings(api_key="monitor-secret", db_path=tmp_path / "monitor.sqlite3")
    store = MonitorStore(settings.db_path)
    store.migrate()
    client = TestClient(create_app(settings=settings, store=store, channel_resolver=object(), runtime_coordinator=NoopRuntime()))

    for http_method, path in [
        ("GET", "/api/monitor/ai-rescue/preflight"),
        ("GET", "/api/monitor/ai-rescue/queue"),
        ("GET", "/api/monitor/ai-rescue/candidates"),
        ("GET", "/api/monitor/ai-rescue/rejections"),
        ("POST", "/api/monitor/ai-rescue/refresh"),
        ("POST", "/api/monitor/ai-rescue/candidates/1/approve"),
        ("POST", "/api/monitor/ai-rescue/candidates/1/reject"),
    ]:
        response = client.request(http_method, path, headers={"x-api-key": "monitor-secret"}, json={"confirm": True})
        assert response.status_code == 404, f"legacy AI Rescue route still exists: {path}"


def test_settings_no_longer_exposes_ai_rescue_or_opencode_runtime_fields(monkeypatch):
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_ENABLED", "true")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_WORKER_ENABLED", "true")
    monkeypatch.setenv("CHANNEL_MONITOR_AI_RESCUE_OPENCODE_API_KEY", "unused")

    settings = load_settings()

    assert [name for name in settings.__dataclass_fields__ if "ai_rescue" in name or "opencode" in name] == []


def test_store_migration_does_not_create_legacy_ai_rescue_tables(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    store = MonitorStore(db_path)
    store.migrate()

    with sqlite3.connect(db_path) as connection:
        table_names = {
            row[0]
            for row in connection.execute(
                "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
            )
        }

    assert not {name for name in table_names if name.startswith("ai_rescue_")}
    assert "rejected_videos" in table_names
    assert "card_context_dismissals" in table_names


def test_card_context_dismissals_accept_only_monitor_card_surface(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    store = MonitorStore(db_path)
    store.migrate()
    store.upsert_card_context_dismissal(
        surface="monitor-card",
        target_context="ecuador",
        video_id="monitor-video",
        dismissed_at="2026-06-05T12:00:00Z",
    )

    with pytest.raises(ValueError, match="invalid_surface"):
        store.upsert_card_context_dismissal(
            surface="ai-rescue-candidate",
            target_context="ecuador",
            video_id="legacy-ai-rescue-video",
            candidate_id=123,
            dismissed_at="2026-06-05T12:05:00Z",
        )

    with sqlite3.connect(db_path) as connection:
        rows = connection.execute("select surface, target_context, video_id, candidate_id from card_context_dismissals").fetchall()

    assert rows == [("monitor-card", "ecuador", "monitor-video", None)]


def test_main_runtime_source_has_no_legacy_ai_rescue_confirmation_helper():
    source = inspect.getsource(monitor_main)

    assert "AI Rescue decisions require explicit confirmation" not in source
    assert "_require_confirmation" not in source


class NoopRuntime:
    async def start(self):
        return None

    async def stop(self):
        return None

    def status(self):
        return {"status": "disabled", "enabled": [], "running": [], "disabled": []}
