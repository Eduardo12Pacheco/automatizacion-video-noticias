# Legacy n8n export (reference only)

`workflows.json` is the sanitized export of the original 16 workflows. It is
kept only so the migration can be inspected: the product logic now lives in
`packages/core`, and **no Compose stack mounts or imports this file**.

> Warning: this export is not a backup and is not safe to activate. It was
> written against the retired Supabase backend, its credential exports were
> removed, and its webhook paths predate the local API. Import it into a
> disposable n8n instance only, never against real accounts or data.

## What to use instead

The supported examples are in [`infra/n8n/workflows/`](../../infra/n8n/workflows/):
two slim workflows that trigger `POST /jobs/discover` and react to the
`job-completed` webhook. See [`docs/CONNECTORS.md`](../../docs/CONNECTORS.md)
for the environment variables and the end-to-end setup.

The only supported way to inspect the historical definitions is a manual
import into a throwaway container; do not mount this directory in Compose.
