# Runbook — Windows services with NSSM (TTS stack)

How to run `tts-worker` and `tts-orchestrator` as automatic Windows services.

## Layout

```text
tts-worker (FastAPI, 127.0.0.1:8091)
        |
tts-orchestrator (FastAPI, 127.0.0.1:8088)
        |
voice_tts_service.cli.synthesize + Qwen3-TTS / Piper
```

Both services use the canonical package entrypoints:

```powershell
python -m uvicorn voice_tts_service.api.worker_app:app --host 127.0.0.1 --port 8091
python -m uvicorn voice_tts_service.api.orchestrator_app:app --host 127.0.0.1 --port 8088
```

The old `tts-worker/`, `tts-orchestrator/` and Cloudflare tunnel helpers were
removed; the panel and the API reach the orchestrator through the local stack.

## Prerequisites

1. PowerShell as Administrator.
2. NSSM: `winget install NSSM.NSSM`.
3. SoX: `winget install --id ChrisBagwell.SoX -e`.
4. Local `.env.local` values (internal token, API key, Python virtualenv).

## Scripts

- `scripts/install-services.ps1` — install/update NSSM services with recovery,
  logs and auto-start.
- `scripts/run-worker.ps1` — worker on `127.0.0.1:8091`.
- `scripts/run-orchestrator.ps1` — orchestrator on `127.0.0.1:8088`.
- `scripts/check-services.ps1` — service state plus local health.

## Install or update

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
& "$env:NEWSROOM_ROOT\services\tts-worker\scripts\install-services.ps1"
```

Services: `tts-worker`, then `tts-orchestrator` (depends on the worker).

## Operations

```powershell
Get-Service tts-worker,tts-orchestrator | Select Name,Status,StartType

Restart-Service tts-worker
Start-Sleep -Seconds 2
Restart-Service tts-orchestrator

Stop-Service tts-orchestrator,tts-worker -Force
Start-Service tts-worker
Start-Sleep -Seconds 2
Start-Service tts-orchestrator

Invoke-WebRequest "http://127.0.0.1:8088/healthz" -UseBasicParsing
```

## Logs

- `runtime-logs/services/tts-worker.out.log`
- `runtime-logs/services/tts-worker.err.log`
- `runtime-logs/services/tts-orchestrator.out.log`
- `runtime-logs/services/tts-orchestrator.err.log`

## Known fixes

- NSSM quote error (`-File '\'`): install the service with the executable only,
  then set `AppParameters` separately.
- `Errno 10048` on ports 8088/8091: stop stray manual processes before restarting
  the services.

TTS inference needs the local machine and its GPU/CPU resources; it is not a
hosted service.
