# ADR 0006 — Connectors are first-class ports

## Status

Accepted.

## Context

The original system coupled the product to specific vendors: n8n owned the
workflows, Supabase owned the data, Firecrawl and Serper extracted and searched,
and a cloud model wrote the scripts. Replacing one of them meant editing
business rules. The rebuild already had ports for the core capabilities, but
the integrations were only discoverable by reading `.env` and the composition
root; an operator could not see what was active or whether it worked.

## Decision

Treat every external integration as a first-class connector:

- One adapter per port, selected by environment (`LLM`, `STORAGE`, `NOTIFY`,
  `WORKFLOW`, `AUTH`, …), with a local default and an optional external
  implementation.
- One registry (`createConnectorRegistry`) that reports `local`, `configured`,
  `disabled` or `error` for every port without returning credentials.
- An admin-only **Conectores / Connectors** screen backed by
  `GET /panel/connectors` and `POST /panel/connectors/:id/test`, plus
  [docs/CONNECTORS.md](../../docs/CONNECTORS.md) with env examples.
- Optional connectors are off by default. The local defaults need no key and
  keep working when an optional adapter is disabled.
- n8n stays a trigger/notification layer, never a second job executor.

## Consequences

- An operator can see and test the active integration set from the UI.
- Adding a connector requires a port contract, a local/demo implementation, a
  test and a registry entry; it cannot be a hidden branch in a use case.
- The registry and its probes are part of the security surface: no secret may
  cross the endpoint, and every probe is bounded.
- The shipped connectors (Ollama/OpenAI-compatible, trafilatura, SearXNG,
  yt-dlp, python-docx, console/SMTP, filesystem/S3, n8n) are documented in one
  place instead of scattered through the code.
