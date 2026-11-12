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

## Local data layer (T3)

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

`POST /panel/uploads/...` accepts up to `MAX_UPLOAD_BYTES` (default 500 MiB).
