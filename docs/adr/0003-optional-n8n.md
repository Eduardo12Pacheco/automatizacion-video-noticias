# ADR 0003 — n8n is optional, not the backend

## Status

Accepted.

## Context

In the original system n8n was the domain backend: 16 workflows, most of them
webhook CRUD over Supabase RPCs, with business rules living in Code nodes. That
made the system hard to test, tied the product to one orchestration tool and
left a large amount of logic outside version-controlled tests. n8n also
requires its own credentials and encryption key.

## Decision

Port the workflow logic into `packages/core` use cases and keep n8n only as an
optional `WorkflowTriggerPort` adapter:

- The in-process job queue and scheduler own orchestration in the default stack.
- The `n8n` Compose profile and the slim example workflows stay available for
  users who want to trigger the API from n8n.
- The historical export remains under `examples/n8n/` as a read-only reference
  fixture, with placeholders instead of secrets.

## Consequences

- The product works with one `docker compose up` and no n8n container.
- Workflow behaviour is now covered by ordinary use-case and HTTP tests.
- Existing n8n users can keep their tool as a thin trigger layer, but they are
  no longer required to understand a 38-node Code-node workflow to change a
  business rule.
- The reference export is not a restorable production backup; credentials and
  the live n8n volume are intentionally absent.
