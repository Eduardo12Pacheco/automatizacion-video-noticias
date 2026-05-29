# Radar Channel Monitor

Backend-only service that monitors configured YouTube sports channels, filters completed VODs, and safely submits matching URLs to Radar. Preserves Radar TXT export behavior by using the existing authenticated `/api/radar/jobs` endpoint as a black box.

## Quick path

1. Copy `.env.example` to `.env` and set `CHANNEL_MONITOR_API_KEY`, Radar, YouTube, and callback values.
2. Start locally with `scripts\run-service.ps1`.
3. Check liveness and authenticated preflight with `scripts\check-service.ps1`.

Do not run real YouTube/Radar long jobs from automated checks. Use fake clients and pytest unless the operator explicitly approves a runtime smoke test.

## Validation

```powershell
python -m pytest "10-Channel-Monitor-Service/tests"
```

No build step is required.

## Operations

- `scripts\run-service.ps1` starts uvicorn on `127.0.0.1:8775` and loads `.env` into the process.
- `scripts\install-service.ps1` installs or updates the NSSM service `radar-channel-monitor`.
- `scripts\check-service.ps1` calls public live and authenticated preflight without exposing secrets.

### Runtime worker loops

FastAPI startup owns one cancellable runtime loop per enabled duty: Radar enqueue retry, transcript summary sync, pending-live polling, SQLite cleanup, Upload playlist catch-up, and optional WebSub renewal. Configure them with `CHANNEL_MONITOR_WORKER_*_ENABLED` and `CHANNEL_MONITOR_WORKER_*_INTERVAL_SECONDS` in `.env`.

Preflight includes runtime checks. Radar reachability uses authenticated GET /api/radar/health only; it does not fetch captions, transcripts, or use AI.

Use `CHANNEL_MONITOR_WORKER_CATCHUP_ENABLED=false` to roll back or pause catch-up. `CHANNEL_MONITOR_CATCHUP_PAGE_LIMIT` and `CHANNEL_MONITOR_CATCHUP_ITEM_LIMIT` cap the per-channel paginated upload scan. Channels may define `uploads_playlist_id` for catch-up.

### Clean Radar baseline reset

Use the explicit reset flow only while workers are stopped or disabled. It preserves channels/configuration and stamps enabled catch-up channels with `baseline_started_at`, so the first post-reset catch-up does not ingest pre-baseline history.

```powershell
Stop-Service radar-channel-monitor
& "<WORKSPACE>\Desktop\n8n\10-Channel-Monitor-Service\scripts\reset-radar-baseline.ps1" -Mode dry-run
& "<WORKSPACE>\Desktop\n8n\10-Channel-Monitor-Service\scripts\reset-radar-baseline.ps1" -Mode apply
Start-Service radar-channel-monitor
& "<WORKSPACE>\Desktop\n8n\10-Channel-Monitor-Service\scripts\check-service.ps1"
```

Rollback: stop the service, restore the generated `.bak` over `runtime\monitor.sqlite3`, revert code/config, restart, then verify `/api/monitor/preflight`, `/api/monitor/cards`, and `/api/monitor/basura`.

### Manual runtime DB reset

Schema migrations are additive and startup must preserve existing runtime data. Never reset the SQLite database from application startup.

```powershell
Stop-Service radar-channel-monitor
Copy-Item "<WORKSPACE>\Desktop\n8n\10-Channel-Monitor-Service\runtime\monitor.sqlite3" "<WORKSPACE>\Desktop\n8n\10-Channel-Monitor-Service\runtime\monitor.sqlite3.bak"
Remove-Item "<WORKSPACE>\Desktop\n8n\10-Channel-Monitor-Service\runtime\monitor.sqlite3"
Start-Service radar-channel-monitor
```

### Operator-approved real smoke plan

Automated verification stays local with pytest and fakes. Only after explicit operator approval, run a real smoke by confirming Transcript/Radar is running, checking `scripts\check-service.ps1`, verifying preflight is ready or intentionally degraded, then triggering one controlled monitored item. Redact API keys, callback secrets, tunnel tokens, and raw callback URLs from shared evidence. Stop or disable the NSSM service, or set the relevant `CHANNEL_MONITOR_WORKER_*_ENABLED=false`, to roll back noisy external work.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---:|---|
| `GET /api/monitor/live` | No | Minimal liveness response. |
| `GET /api/monitor/health` | `x-api-key` | Redacted preflight. |
| `GET /api/monitor/preflight` | `x-api-key` | Alias for redacted preflight checks. |
| `POST /api/monitor/radar-baseline-reset` | `x-api-key` | Dry-run/apply clean baseline reset with backup and confirmation. |
| `GET /api/monitor/basura` | `x-api-key` | Paged rejected/non-matching videos preserved for review. |
| `GET /api/monitor/summary` | `x-api-key` | Fixed target-country counters plus `basura_count`. |
