# API gateway migration baseline

The existing HTTP entrypoint is `src/gateway.js`; security regression tests are
in `test/gateway-security.test.js`. This service will move into `apps/api`
during the local-first migration.

## Verify the existing boundary

```sh
node --test test/gateway-security.test.js
```

Protected panel calls must pass through the authenticated gateway. The panel
uses `/panel/bootstrap` and `/panel/session` for configuration and session state.
Do not introduce direct browser access to protected worker services while
reorganizing files.

Cloudflare deployment instructions are historical, not a requirement for the
local product: do not guess deployed settings or use them as proof of local
health. No tunnel or cloud account is needed for the intended default stack.

Keep Voice TTS presets, refs, segmentation, sample rate, artifacts and runtime
behavior unchanged during this structural migration. See the panel's
`docs/collaboration-boundary-rollout-checklist.md` for the existing boundary
checks; optional public deployment is outside this task.

## Local data layer

The gateway composes `packages/data` at startup (`src/composition.js`):

- `DATABASE_URL` present: Postgres repository + `infra/db/migrations/*.sql`
  (run `node packages/data/scripts/migrate.js` or let the installer do it).
- `DATABASE_URL` absent: in-memory repository for demo/showcase mode.
- Blobs always go to `BLOB_ROOT` (default `./data/blobs`) through
  `FsBlobStorage`; the browser reads them from `/panel/blobs/...`.

Panel video-project reads and mutations use `/panel/read-models/video-projects`
and `/panel/video-projects/:draftId/*`. Uploads use
`POST /panel/uploads/<bucket>/<path>`; the old direct browser→Supabase calls
were removed. The gateway still enforces the panel session, editor role and
CSRF origin on mutations.

`POST /panel/uploads/...` accepts up to `MAX_UPLOAD_BYTES` (default 64 MiB). Uploads are buffered in memory, so larger source videos must use the subtitles worker endpoint; a declared size over the limit returns 413 before the body is read.

## Core use cases and local workflow endpoints

`packages/core` ports the 16 n8n workflows into use cases: DiscoverNews,
ClusterTopics, DecideApproval, DraftScript, PublishScript,
CreateVideoProject, ManualCreateVideoProject, RefreshSearch, read models and
ExportDocument. Adapters are injected through ports; the local adapter package supplies the local
Ollama/trafilatura/SearXNG/python-docx implementations.

The gateway composes them in `src/core-runtime.js` and serves the existing
panel paths through `src/local-router.js`:

- `GET /webhook/approval/pending|queue|topic/supabase/...`
- `POST /webhook/approval/decision|search-refresh/supabase/...`
- `GET /webhook/mvp-script-drafts-pending/supabase/v2`
- `POST /webhook/mvp-script-draft-save|publish|publish-status|download-doc/...`
- `POST /webhook/video-projects/manual-create/v1`
- matching `/panel/read-models/approval/*` and
  `/panel/read-models/scripts/drafts` read models.

Mutations still require an authenticated `editor` session and a trusted
origin. Search refresh, publish and manual-project work run through the
in-process `JobQueue`; the `Scheduler` periodically deletes expired sessions.

## Local users and sessions

Users, roles and sessions live in the repository (`users`, `user_roles`,
`sessions`). Passwords are bcrypt hashes and only session-token hashes are
stored. `POST /panel/login` uses the repository first and keeps the legacy
env-configured panel user as a fallback. Admin endpoints are mounted only for
the `admin` role:

- `GET|POST /panel/admin/users`
- `PATCH /panel/admin/users/:id`
- `GET /panel/admin/roles`

The gateway modules are now split by concern: `auth.js` (users/passwords),
`sessions.js` (cookie/session shape), `presence.js`, `local-router.js`
(workflow endpoints), `admin-router.js`, `core-runtime.js` (composition),
`data-router.js`, and `gateway-events.js`. `gateway.js` remains the HTTP
composition point and protected proxy.

## Local-first adapters

`packages/adapters` provides the local implementations behind the core ports
and `src/core-runtime.js` injects them from environment variables:

| Port | Local default | Optional alternative |
|---|---|---|
| `LLMPort` | `OllamaLLMAdapter` (`LLM=ollama`, `/api/chat`) | `LLM=openai` OpenAI-compatible endpoint |
| `NewsSourcePort` | `RssNewsSourceAdapter` (Google News RSS) | `NEWS_SOURCE=none` |
| `ArticleExtractorPort` | `TrafilaturaArticleExtractor` (local Python CLI) | `ARTICLE_EXTRACTOR=none` |
| `ImageSearchPort` | `SearxngWikimediaImageSearch` (SearXNG + Wikimedia) | `IMAGE_SEARCH=none` |
| `DocumentExportPort` | `LocalDocumentExport` (python-docx + Markdown) | `DOCUMENT_EXPORT=none` |
| `NotificationPort` | `ConsoleNotificationAdapter` | `NOTIFY=smtp` (Mailpit/Gmail app password) |
| `ChannelFeedPort` | `RssChannelFeedAdapter` (YouTube RSS) | `CHANNEL_FEED=none` |
| `MediaDownloadPort` | `WorkerMediaDownload` (ASR worker `/api/radar/download`) | `MEDIA_DOWNLOAD=none` |
| `WorkflowTriggerPort` | off (`WORKFLOW=disabled`) | `WORKFLOW=n8n` + webhook URL |

No key is required by the defaults. The trafilatura/python-docx helper is
`packages/python/newsroom_local_adapters`; install its dependencies with
`uv sync` there (or `pip install trafilatura python-docx`) so `PYTHON_BIN` can
import them. `SMTP_STARTTLS=true` plus `SMTP_USER`/`SMTP_PASS` is the documented
Gmail path; Mailpit uses the plain `127.0.0.1:1025` default.

Adapter unit tests run without any service:

```sh
node --test packages/adapters/test/*.test.js
```

The network/service checks are opt-in and marked `live`:

```sh
NEWSROOM_LIVE_TESTS=1 node --test packages/adapters/test/live.test.js
```
