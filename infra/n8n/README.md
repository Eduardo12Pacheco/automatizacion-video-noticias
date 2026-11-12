# Local n8n

Legacy n8n container for inspecting the historical workflow export. The new
local-first product does not require a tunnel, cloud account or n8n credentials.
This file is retained during migration; it is not the default product stack.

## Runtime

```text
https://n8n.example.local
  -> Cloudflare Tunnel
  -> http://127.0.0.1:5678
  -> Docker container local-n8n
```

The Api Gateway can also route `/n8n/*` to this local service when configured to use `http://127.0.0.1:5678`.

## Files

- `docker-compose.yml` — local n8n container pinned to `n8nio/n8n:1.123.52`.
- `.env` — local secrets and public URL settings. Ignored by git.
- `../../examples/n8n/` — single sanitized workflow reference, mounted read-only at `/import`.
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

Inspect the [workflow reference](../../examples/n8n/README.md) before importing
into a disposable instance. Credential exports are intentionally not included:

```powershell
docker compose run --rm n8n n8n import:workflow --input=/import/workflows.json
```

## Important

Do not lose `N8N_ENCRYPTION_KEY`. Restored credentials depend on it.
