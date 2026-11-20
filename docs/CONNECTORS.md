# Connectors

Every external integration in the product is an adapter behind a port. The
composition root in `packages/adapters/src/composition.js` (API runtime) and
`apps/api/src/composition.js` (data layer) selects one adapter per port from
environment variables. Local adapters are the default, and every optional
connector is off unless you configure it.

In `NEWSROOM_MODE=demo` the composition root forces the deterministic demo
adapters (LLM, extraction, TTS, ASR, translation and renderer) regardless of
the values below, so the panel badge cannot lie about a run. The connector
registry still reports the configured adapters for inspection. In
`NEWSROOM_MODE=local` the values below select the real adapters.

The panel shows the active adapter and status for each port under
**Administración → Conectores** (admin only). `GET /panel/connectors` returns
the catalogue without credentials, and `POST /panel/connectors/:id/test` runs
one bounded probe. Statuses mean:

| Status | Meaning |
|---|---|
| `local` | A bundled local adapter is active (Ollama, filesystem, RSS, …). |
| `configured` | An optional adapter is configured (SMTP, n8n, S3, OpenAI-compatible LLM, …). |
| `disabled` | The port has no adapter (`*_ADAPTER=none` / `LLM=none`). |
| `error` | The last connection test failed. Details stay in the panel; no secret is returned. |

All variables are read from `.env` by Compose and by a native `node
apps/api/src/gateway.js` run. Restart the API after changing one.

## At a glance

| Connector | Env switch | Default | What it does |
|---|---|---|---|
| Ollama / any OpenAI-compatible LLM | `LLM=ollama\|openai` | Local Ollama | Scripts, clustering, classification |
| SMTP / Gmail | `NOTIFY=smtp` | Console | Notification e-mail (Gmail uses an app password) |
| S3 / MinIO | `STORAGE=s3` | Filesystem | Blob storage for uploads and renders |
| n8n | `WORKFLOW=n8n` | Disabled | Cron trigger (`POST /jobs/discover`) and job-completed webhook |

All optional connectors are off by default; their credentials come from `.env`
and are never returned by the API or committed to the repository.

## n8n (workflow trigger)

Use n8n only as a cron/notification layer; the domain logic stays in
`packages/core`. The two supported workflows live in `infra/n8n/workflows/`
and are copied into the container at `/workflows`.

```dotenv
WORKFLOW=n8n
N8N_WEBHOOK_BASE_URL=http://n8n:5678
N8N_WEBHOOK_TOKEN=                      # optional bearer for the n8n webhooks
JOBS_API_KEY=change-me                  # the API half of the connector
NEWSROOM_NOTIFY_EMAIL=editor@example.local
```

Commands:

```sh
docker compose --profile n8n up -d
docker compose exec n8n n8n import:workflow --input=/workflows/discover-cron.json
docker compose exec n8n n8n import:workflow --input=/workflows/job-completed-notification.json
```

- `discover-cron.json` runs daily at 06:00 and calls
  `POST $NEWSROOM_API_URL/jobs/discover` with `Authorization: Bearer
  $NEWSROOM_JOBS_TOKEN`. Set `NEWSROOM_JOBS_TOKEN` in the n8n container to the
  same value as `JOBS_API_KEY`.
- `job-completed-notification.json` exposes `POST /webhook/job-completed`. The
  API calls it after every queue job when `WORKFLOW=n8n`. Attach an SMTP
  credential to its email node.

Single orchestration: the in-process queue is always the only path that
executes jobs, with or without n8n. `WORKFLOW=n8n` adds an outbound
`job-completed` notification and lets n8n call `POST /jobs/discover`; it never
enqueues a second copy of a draft job. This is why the two shipped workflows are
enough: n8n triggers the API and receives events, it does not own the domain.

How to test:

```sh
curl -fsS -X POST http://127.0.0.1:8099/jobs/discover \
  -H "Authorization: Bearer $JOBS_API_KEY"
# 202 {"ok":true,"status":"accepted","run_id":"..."}
```

The panel's **Conectores → n8n → Probar** button checks `GET /healthz` on the
n8n instance. The legacy 16-workflow export under `examples/legacy-n8n/` is
never mounted by Compose and is not supported for live use.

## SMTP / Gmail (notifications)

The default is a console adapter that logs one redacted line per notification.
Mailpit is included in the default stack for local inspection.

```dotenv
NOTIFY=smtp
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_FROM=newsroom@example.local
SMTP_STARTTLS=false
SMTP_USER=
SMTP_PASS=
```

Gmail (or any provider) uses an app password, never the account password:

```dotenv
NOTIFY=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_STARTTLS=true
SMTP_USER=your-address@gmail.com
SMTP_PASS=your-16-character-app-password
SMTP_FROM=your-address@gmail.com
```

How to test:

```sh
# Mailpit: open http://127.0.0.1:8025 (debug profile) or use the API
curl -fsS http://127.0.0.1:8025/api/v1/messages

# Run the same contract against a live Mailpit or SMTP server
NEWSROOM_LIVE_TESTS=1 SMTP_HOST=127.0.0.1 SMTP_PORT=1025 \
  node --test --test-name-pattern="SMTP notification" packages/adapters/test/live.test.js
```

The panel's **Probar** button opens the SMTP connection and reads the greeting
(`EHLO`) without sending a message.

## OpenAI-compatible LLM (optional cloud/self-hosted)

The default LLM is Ollama at `http://localhost:11434` with
`qwen2.5:3b-instruct`; it needs no key. Any OpenAI-compatible endpoint can be
selected instead:

```dotenv
LLM=openai
OPENAI_BASE_URL=https://api.example.com/v1
OPENAI_MODEL=your-model
OPENAI_API_KEY=sk-...        # optional for local OpenAI-compatible servers
LLM_TIMEOUT_MS=300000
```

Ollama exposes an OpenAI-compatible endpoint too, so `LLM=openai` with
`OPENAI_BASE_URL=http://localhost:11434/v1` works without a key.

How to test:

```sh
node --test --test-name-pattern="local mock server" packages/adapters/test/llm.test.js
```

The panel's **Probar** button calls `GET {OPENAI_BASE_URL}/models`. The API
never returns the key; only the adapter name, model and base URL are listed.

## S3-compatible blob storage (MinIO, Garage, AWS S3)

The default blob store is the local filesystem under `BLOB_ROOT`
(`./data/blobs`). The optional adapter stores the same keys in an
S3-compatible bucket; the browser still downloads them from
`/panel/blobs/...`, so nothing else changes.

```dotenv
STORAGE=s3
S3_ENDPOINT=http://minio:9000
S3_BUCKET=newsroom
S3_REGION=us-east-1
S3_ACCESS_KEY=newsroom                 # same as MINIO_ROOT_USER
S3_SECRET_KEY=change-me                # same as MINIO_ROOT_PASSWORD
```

The installer template uses `__GENERATE_MINIO_ROOT_PASSWORD__` so the API
client secret and the MinIO root password are generated as the same value.

Start MinIO and create the bucket:

```sh
STORAGE=s3 docker compose --profile s3 up -d minio api panel
docker compose --profile s3 run --rm minio-init
```

The adapter uses path-style addressing and SigV4 signed with Node's `crypto`;
no AWS SDK is installed.

How to test (the live test starts from an empty bucket and cleans up its key):

```sh
S3_TEST_ENDPOINT=http://127.0.0.1:9000 \
S3_TEST_BUCKET=newsroom \
S3_TEST_ACCESS_KEY=... \
S3_TEST_SECRET_KEY=... \
  node --test --test-name-pattern="MinIO" packages/data/test/s3-blob-storage.test.js
```

The panel's **Probar** button performs a `HEAD` on the bucket.

## Local adapters

These adapters are local by design and need no key. They are listed in the
panel with status `local`; their **Probar** button runs a bounded local check.

| Port | Adapter | Variables | Test |
|---|---|---|---|
| `NewsSourcePort` | Google News RSS | `NEWS_SOURCE=rss` | No remote probe; adapter is always available. |
| `ArticleExtractorPort` | trafilatura CLI | `ARTICLE_EXTRACTOR=trafilatura`, `PYTHON_BIN` | Python binary availability. |
| `ImageSearchPort` | SearXNG + Wikimedia Commons | `IMAGE_SEARCH=searxng`, `SEARXNG_URL`, `IMAGE_SEARCH_WIKIMEDIA` | One tiny image query. |
| `DocumentExportPort` | python-docx + Markdown | `DOCUMENT_EXPORT=local`, `DOCUMENT_ROOT` | Python binary availability. |
| `TTSPort` | Piper CPU / Qwen GPU worker | `TTS=worker`, `TTS_BASE_URL` | `GET /health`. |
| `ASRPort` | faster-whisper worker | `ASR=worker`, `ASR_BASE_URL` | `GET /health`. |
| `TranslationPort` | subtitles worker | `TRANSLATION=worker`, `SUBTITLES_BASE_URL` | `GET /api/subtitles/health`. |
| `VideoRendererPort` | Remotion renderer | `RENDERER=worker`, `RENDERER_BASE_URL` | `GET /health`. |
| `ChannelFeedPort` | public YouTube RSS | `CHANNEL_FEED=rss` | No remote probe. |
| `MediaDownloadPort` | yt-dlp through the ASR worker | `MEDIA_DOWNLOAD=worker`, `ASR_BASE_URL` | `GET /health`. |
| `AuthPort` | local repository auth | `AUTH=local` | Active adapter check. |
| `RepositoryPort` | Postgres / in-memory | `DATABASE_URL` | One read query. |
| `BlobStoragePort` | filesystem / S3 | `STORAGE`, `BLOB_ROOT` | Read/write probe or bucket `HEAD`. |

Disable a capability with `LLM=none`, `IMAGE_SEARCH=none`, `NOTIFY=none`,
`WORKFLOW=disabled`, `TTS=none`, …; the API then returns a typed `503` only for
the operations that need it and keeps the read/save surfaces available.
