# Local n8n

Runs the migrated n8n instance locally on Windows while preserving the public webhook URL through Cloudflare Tunnel.

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
- `import/` — temporary import mount for exported workflows and credentials. Ignored if you keep sensitive files out of git.
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

Import backup after `.env` is ready:

```powershell
docker compose run --rm n8n n8n import:credentials --input=/import/credentials.json
docker compose run --rm n8n n8n import:workflow --input=/import/workflows.json
```

## Important

Do not lose `N8N_ENCRYPTION_KEY`. Restored credentials depend on it.
