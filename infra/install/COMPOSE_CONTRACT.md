# Docker Compose contract for the installers

`install.sh` / `install.ps1` and the `newsroom` CLI are thin orchestrators. They
do not build containers themselves; they call a root `compose.yaml` through the
Docker Compose plugin. T8 owns that file and its images. This document is the
contract the installers rely on, so T8 can implement it without re-reading the
shell/PowerShell code.

## Files

| Path | Owner | Purpose |
|---|---|---|
| `compose.yaml` (repo root) | T8 | Stack definition, profiles and volumes |
| `docker-compose.yml` (repo root) | T8 | Compatibility alias (`include:`) for tools that look for the old filename |
| `.env.example` → `.env` | T8b installer | Configuration; `.env` is generated with secrets and never committed |
| `infra/db/migrations/*.sql` | T3 | Applied by the `migrate` service |
| `apps/api/scripts/create-admin.js` | T8b | First-admin bootstrap run inside the API image |

`compose.yaml` must read the generated `.env` (Compose does this by default; the
installers also pass `--env-file .env`).

## Services used by the installers

| Service | Kind | Contract |
|---|---|---|
| `api` | long-running | Serves the gateway on port 8099. Working directory must contain `scripts/create-admin.js` (so `node scripts/create-admin.js` works). Contains the local adapters' Python helper and `yt-dlp`. Uses `${DATABASE_URL}`, `${BLOB_ROOT}` and the adapter variables from `.env`. |
| `panel` | long-running | Serves `apps/panel` on `${PANEL_PORT}` (8080) and reverse-proxies `/panel`, `/webhook`, `/tts`, `/subtitles`, `/remotion`, `/radar`, `/monitor` and `/approval` to `api:8099`. |
| `seed` | one-shot, default | Applies the migrations and seeds the fictional users, one pending topic and one complete story. Idempotent. |
| `demo-worker` | long-running | Deterministic TTS/subtitles/render contracts for the keyless default profile; serves a WAV and the demo MP4. |
| `ollama` | default (CPU) / `gpu` | Local LLM server. Its entrypoint pulls `${OLLAMA_MODEL}` into the model volume on first start. |
| `postgres` | long-running | `postgres:16`, database `${POSTGRES_DB}`, user `${POSTGRES_USER}`, password `${POSTGRES_PASSWORD}`, volume `postgres_data`, healthcheck. |
| `searxng` | long-running | JSON API enabled on `${SEARXNG_PORT}` (8888) for `ImageSearchPort`. |
| `mailpit` | long-running | SMTP on `${MAILPIT_SMTP_PORT}` (1025) and UI on `${MAILPIT_UI_PORT}` (8025) for the optional SMTP notification adapter. |
| `migrate` | one-shot | `node packages/data/scripts/migrate.js` with `${DATABASE_URL}`; exits 0 after applying migrations. Idempotent. |
| `model-init` | one-shot (`tools`) | Downloads the Piper voice `${PIPER_MODEL}` and the faster-whisper model `${WHISPER_MODEL}`. Idempotent and GPU-free; Ollama pulls its own model on first start. |
| `tts-worker` | `gpu` profile (Piper CPU fallback) | `TTS_WORKER_ENGINE=auto`; uses the shared GPU lock volume/path. |
| `asr-worker` | `gpu` profile (CPU fallback) | faster-whisper; uses `WHISPER_DEVICE` and the shared GPU lock. |
| `n8n` | `n8n` profile, optional | Must stay off by default (`WORKFLOW=disabled`). Never required by the installer. |

The default profile (no `--profile` beyond `cpu`) starts **api + panel +
demo-worker + seed + Postgres + SearXNG + Mailpit + Ollama** with seed data and
no API keys. `seed` is idempotent and exits; `migrate` and `model-init` are in
the `tools` profile and are invoked explicitly with `run --rm`.

## Exact commands the installer runs

From the repository root, with `--env-file .env -f compose.yaml --profile <cpu|gpu>`:

```text
docker compose ... build --pull
docker compose ... run --rm model-init          # skipped with --no-models / -NoModels
docker compose ... run --rm migrate             # skipped when the install state says applied
printf '<password>' | docker compose ... run --rm -T api node scripts/create-admin.js --email <email> --password-stdin
docker compose ... up -d --build
```

The control CLI adds:

```text
docker compose ... up -d --build
docker compose ... down --remove-orphans
docker compose ... ps
docker compose ... logs --tail=200 [-f] [service]
docker compose ... pull
docker compose ... build --pull
docker compose ... run --rm migrate
```

`newsroom update` runs `git pull --ff-only` first when a remote is configured,
and refuses to run with uncommitted changes.

## Requirements for the one-shot services

- `model-init` and `migrate` must be safe to run repeatedly.
- They must be excluded from the default `up` (use a profile such as
  `tools`, `restart: "no"`, or an entrypoint that exits; whichever T8 chooses,
  the installer invokes them explicitly with `run --rm`).
- `migrate` should depend on Postgres being healthy.
- `create-admin.js` must be idempotent (T8b implements that) and must read the
  password from stdin, never from argv.

## Ports and volumes

Defaults come from `.env.example`; every port must be overridable through `.env`:
`PANEL_PORT=8080`, `API_GATEWAY_PORT=8099`, `POSTGRES_PORT=5432`,
`SEARXNG_PORT=8888`, `MAILPIT_SMTP_PORT=1025`, `MAILPIT_UI_PORT=8025`,
`OLLAMA_PORT=11434`, `N8N_PORT=5678`. Only the panel and API publish ports, and
they bind to `${NEWSROOM_BIND:-127.0.0.1}`. Internal services stay on the
Compose network; `infra/compose/compose.debug.yaml` adds their ports for
debugging. `POSTGRES_PASSWORD`, `SEARXNG_SECRET` and `N8N_ENCRYPTION_KEY` use
`${VAR:?run ./install.sh first}` and have no weak fallback.

Persistent data lives in named volumes: Postgres, blobs/documents, models
(Ollama, Whisper, Piper), n8n (optional). `newsroom down` keeps them;
`install.sh --uninstall --purge` deletes them after the typed `delete` confirmation (`--force-purge` skips it for automation).

## Health

`api` exposes `GET /health` and `GET /ready`; T8's compose healthchecks and the
Playwright happy path should use them. `newsroom status` is a thin
`docker compose ps`, so no extra API is needed.
