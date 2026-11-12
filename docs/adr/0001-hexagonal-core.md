# ADR 0001 — Hexagonal core with ports and adapters

## Status

Accepted.

## Context

The original product put business rules inside n8n Code nodes, a 1,981-line
gateway file and browser calls to Supabase. That made the domain impossible to
test without external services, duplicated Whisper/YouTube/yt-dlp code across
services and created a circular dependency between the panel and the video
engine. The rebuild needs one place for the rules and an easy way to swap a
cloud capability for a local one.

## Decision

Use a hexagonal architecture:

- `packages/core` owns use cases, domain rules, the job queue and the ports
  consumed by those use cases.
- `packages/data` owns `RepositoryPort` and `BlobStoragePort` with in-memory,
  Postgres and filesystem adapters.
- `packages/adapters` owns local-first implementations of the external ports
  (LLM, article extraction, image search, RSS, media download, document export,
  notifications and the optional n8n trigger).
- `apps/api` is the only driving HTTP adapter. One composition root selects
  adapters from environment variables.
- Dependencies point inward: the core never imports an adapter, a database
  client or browser code.

Tests inject in-file mocks or the in-memory repository. The same repository
contract suite runs against Postgres when `TEST_DATABASE_URL` is configured.

## Consequences

- Domain behaviour is covered by fast, deterministic tests with no network.
- A local capability can be replaced or disabled (`LLM=none`, `NOTIFY=none`)
  without changing use cases.
- There is more wiring code in the composition root, and every new capability
  needs a port plus at least one adapter.
- The former n8n workflows are now ordinary code, so they can be reviewed,
  versioned and tested like the rest of the repository.
