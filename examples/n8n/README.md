# Historical workflow reference

`workflows.json` is the single sanitized export of the original 16 workflows.
It preserves the previously imported definitions for the core migration; it is
not the default local-first backend or a working cloud deployment.

## Inspect or import

Review the definitions before importing them into a disposable n8n instance.
The legacy Compose file in `local/n8n/` mounts this directory read-only at
`/import`; it never includes credential exports.

```sh
docker compose -f local/n8n/docker-compose.yml run --rm n8n \
  n8n import:workflow --input=/import/workflows.json
```

External endpoints use example hosts; removed secrets are placeholders.
An import alone does not restore accounts, database state, credentials or media.
Do not activate these historical workflows against real services.

The two former working snapshots contained the same 16 workflow IDs but had
different bytes. The import export is canonical because it was the actual
import fixture, not because all three snapshots were identical.

The optional local-first trigger examples will replace this reference once the
domain use cases have moved into `packages/core`.
