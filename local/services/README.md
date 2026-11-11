# Local Services

## transcript-service-radar

- Start from `09-Transcript-Service` with `./scripts/run-dev.ps1` or install with `./scripts/install-nssm.ps1`.
- Public liveness check: `GET http://127.0.0.1:8765/api/radar/live`.
- Authenticated health/preflight check: `GET http://127.0.0.1:8765/api/radar/health` with `x-api-key`, or `./scripts/check-preflight.ps1` with `TRANSCRIPT_SERVICE_API_KEY` set.
- Rollback: stop the NSSM service, disable the Cloudflare Tunnel route, and remove the Radar settings from the Control Panel.
