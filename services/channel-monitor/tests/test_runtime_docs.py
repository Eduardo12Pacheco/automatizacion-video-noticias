from __future__ import annotations

from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]


def test_service_scripts_use_safe_powershell_patterns_and_no_build_commands():
    scripts = {
        "run-service.ps1": SERVICE_ROOT / "scripts" / "run-service.ps1",
        "install-service.ps1": SERVICE_ROOT / "scripts" / "install-service.ps1",
        "check-service.ps1": SERVICE_ROOT / "scripts" / "check-service.ps1",
    }

    contents = {name: path.read_text(encoding="utf-8") for name, path in scripts.items()}

    assert "python -m uvicorn app.main:app" in contents["run-service.ps1"]
    assert "radar-channel-monitor" in contents["install-service.ps1"]
    assert "Invoke-WebRequest" in contents["check-service.ps1"]
    assert all("npm run build" not in content.casefold() for content in contents.values())
    assert all("Set-Location" not in content for content in contents.values())


def test_readme_documents_quick_path_preflight_and_no_real_long_jobs():
    readme = (SERVICE_ROOT / "README.md").read_text(encoding="utf-8")

    assert "## Quick path" in readme
    assert "scripts\\check-service.ps1" in readme
    assert "Do not run real YouTube/Radar long jobs" in readme
    assert "Preserves Radar TXT export behavior" in readme


def test_docs_cover_runtime_toggles_safe_preflight_and_operator_smoke_plan():
    env_example = (SERVICE_ROOT / ".env.example").read_text(encoding="utf-8")
    readme = (SERVICE_ROOT / "README.md").read_text(encoding="utf-8")
    check_script = (SERVICE_ROOT / "scripts" / "check-service.ps1").read_text(encoding="utf-8")

    for name in [
        "CHANNEL_MONITOR_WORKER_ENQUEUE_ENABLED",
        "CHANNEL_MONITOR_WORKER_PENDING_LIVE_INTERVAL_SECONDS",
        "CHANNEL_MONITOR_WORKER_CLEANUP_INTERVAL_SECONDS",
        "CHANNEL_MONITOR_WORKER_WEBSUB_ENABLED",
        "CHANNEL_MONITOR_WORKER_CATCHUP_ENABLED",
        "CHANNEL_MONITOR_WORKER_CATCHUP_INTERVAL_SECONDS",
        "CHANNEL_MONITOR_WORKER_TRANSCRIPT_SYNC_ENABLED",
        "CHANNEL_MONITOR_WORKER_TRANSCRIPT_SYNC_INTERVAL_SECONDS",
        "CHANNEL_MONITOR_CATCHUP_PAGE_LIMIT",
        "CHANNEL_MONITOR_CATCHUP_ITEM_LIMIT",
        "CHANNEL_MONITOR_BACKEND_CARD_DEFAULT_LIMIT",
    ]:
        assert name in env_example
    assert "Runtime worker loops" in readme
    assert "transcript summary sync" in readme
    assert "RSS channel catch-up" in readme
    assert "uploads_playlist_id" in readme
    assert "CHANNEL_MONITOR_WORKER_CATCHUP_ENABLED=false" in readme
    assert "reset-radar-baseline.ps1" in readme
    assert "POST /api/monitor/radar-baseline-reset" in readme
    assert "does not fetch captions, transcripts, or use AI" in readme
    assert "authenticated GET /api/radar/health" in readme
    assert "Operator-approved real smoke plan" in readme
    assert "Stop or disable the NSSM service" in readme
    assert "redact" in readme.casefold()
    assert "/api/monitor/preflight" in check_script


def test_protected_boundary_smoke_script_documents_safe_local_checks_only():
    script = (SERVICE_ROOT / "scripts" / "check-protected-boundary.ps1").read_text(encoding="utf-8")
    readme = (SERVICE_ROOT / "README.md").read_text(encoding="utf-8")

    assert "Get-Service -Name \"radar-channel-monitor\"" in script
    assert "StartType -eq 'Manual'" in script
    assert "Status -ne 'Running'" in script
    assert "CHANNEL_MONITOR_NETWORK_MODE" in script
    assert "CHANNEL_MONITOR_NETWORK_BOUNDARY_URL" in script
    assert "CHANNEL_MONITOR_NETWORK_BOUNDARY_TOKEN" in script
    assert "[redacted]" in script
    assert "/api/monitor/preflight" in script
    assert "policy_forbidden_local_youtube" in script
    assert "boundary_misconfigured" in script
    assert "no local YouTube provider fallback" in script
    assert "youtube.com" not in script.casefold()
    assert "googleapis" not in script.casefold()
    assert "yt-dlp" not in script.casefold()
    assert "Protected boundary smoke" in readme
    assert "scripts\\check-protected-boundary.ps1" in readme
    assert "does not start or restart" in readme


def test_readme_documents_manual_runtime_reset_and_basura_endpoints():
    readme = (SERVICE_ROOT / "README.md").read_text(encoding="utf-8")

    assert "Manual runtime DB reset" in readme
    assert "Stop-Service radar-channel-monitor" in readme
    assert "Copy-Item" in readme
    assert "Remove-Item" in readme
    assert "services/channel-monitor\\runtime\\monitor.sqlite3" in readme
    assert "Never reset the SQLite database from application startup" in readme
    assert "GET /api/monitor/basura" in readme
    assert "GET /api/monitor/summary" in readme
