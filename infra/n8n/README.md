# Local n8n

Optional n8n container for the two supported trigger workflows. The product
does not require n8n, a tunnel or cloud credentials: the in-process queue is the
default orchestration path. Use this compose file only when you want n8n as a
cron/notification layer (`WORKFLOW=n8n`).

## Runtime

```text
http://127.0.0.1:5678
  -> Docker container local-n8n
```

The API gateway can also proxy `/n8n/*` to this local service when
`API_GATEWAY_N8N_TARGET` points at it.

## Files

- `docker-compose.yml` — local n8n container pinned to `n8nio/n8n:1.123.52`.
- `.env` — local secrets and public URL settings. Ignored by git.
- `workflows/` — the two supported trigger workflows, mounted read-only at
  `/workflows`. The historical 16-workflow export is **not** mounted; it lives
  under `examples/legacy-n8n/` as read-only history.
- `files/` — n8n `/files` mount for local file workflows.

## Commands

From this folder:

```powershell
docker compose up -d
docker compose logs -f n8n
docker compose exec n8n n8n --version
```

## Automatic startup

Docker Desktop is a user-session application on Windows. The reliable startup path is the scheduled task:

```text
Local Automation Stack Startup
```

It runs at user logon, waits for Docker Desktop, starts `docker compose up -d`, and checks local/public n8n health.

Do not run local n8n through an NSSM `LocalSystem` service. That can start Docker Desktop under the wrong Windows context and cause Docker pipe access errors.

Import the supported workflows:

```powershell
docker compose run --rm n8n n8n import:workflow --input=/workflows/discover-cron.json
docker compose run --rm n8n n8n import:workflow --input=/workflows/job-completed-notification.json
```

Set `NEWSROOM_API_URL`, `NEWSROOM_JOBS_TOKEN` and `NEWSROOM_NOTIFY_EMAIL` in
the n8n environment, then attach an SMTP credential to the notification node.
See [docs/CONNECTORS.md](../../docs/CONNECTORS.md) for the full walkthrough.

## Important

Do not lose `N8N_ENCRYPTION_KEY`. Restored credentials depend on it.

Never import `examples/legacy-n8n/workflows.json` into a live instance: it
targets the retired Supabase backend and is kept for inspection only.
