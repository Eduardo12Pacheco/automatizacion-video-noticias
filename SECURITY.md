# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use the
repository's private vulnerability reporting form (GitHub **Security** tab →
**Report a vulnerability**) and include:

- the affected version, file or route;
- the steps to reproduce, ideally against a local demo stack;
- the impact you think it has;
- whether the issue is already public.

You can expect an acknowledgement within a few days. This is a portfolio
project maintained by one person; there is no paid support or SLA. Please give a
reasonable window to ship a fix before publishing details.

## Supported versions

Only the latest `feat/local-first-product` / published `main` revision is
supported. There are no long-term branches or backports.

## Security defaults

The product is designed to run on a laptop, next to the owner, with no cloud
dependency:

- **Loopback by default.** Published ports bind to
  `${NEWSROOM_BIND:-127.0.0.1}`. Opening the panel to a LAN is an explicit
  choice, documented in [docs/INSTALL.md](docs/INSTALL.md).
- **No published internal services.** Postgres, SearXNG, Mailpit, Ollama and
  n8n are not published unless the `debug` profile is enabled on purpose.
- **Generated secrets.** The installers create random secrets in `.env` (mode
  `0600`); Compose uses `${VAR:?run ./install.sh first}` instead of weak
  fallbacks. `.env` is never committed.
- **Real auth.** Users live in the local database with bcrypt password hashes;
  `admin`, `editor` and `viewer` roles are enforced server-side by one route
  table and one role middleware. Sessions are HTTP-only, `SameSite=Lax`
  cookies with a hashed server-side store and expiry.
- **First admin is installer-created.** There is no hardcoded default password,
  and the credentials are printed once in the installer summary.
- **Mutations are protected.** Every mutating panel route requires a session,
  the right role and a trusted Origin; audit, presence and error read models are
  admin-only. The sole authenticated route that is not role-gated is
  `POST /panel/presence/heartbeat`, which writes only ephemeral presence state.
  Login throttling keys on user plus client IP, reads the client address from
  the right-most untrusted forwarding hop, and trusts `X-Forwarded-For` only
  from the panel container's own address. Live locks are never evicted by a
  username flood, a per-IP bucket backs the per-user lock, and a password
  reset revokes every existing session for that user.
- **Internal workers are token-gated.** The approval editor, renderer and
  demo worker reject API calls without the installer-generated `x-api-key`;
  development runs bind to `127.0.0.1`. The gateway injects the token over the
  Compose network.
- **Anti-framing and a strict CSP.** The panel sends `X-Frame-Options: DENY`,
  `frame-ancestors 'none'`, `script-src 'self'` (no inline scripts), nosniff,
  a same-origin referrer policy and a minimal permissions policy. Inline style
  attributes are allowed because the progress/timeline renderers set them.
- **SSRF guard on discovered URLs.** Article extraction and preview fetches
  reject loopback, private, link-local, CGNAT, multicast, reserved and IPv6
  equivalents, single-label hosts (Compose service names) and redirects to
  those destinations, after DNS resolution. Media downloads additionally
  allow-list YouTube hosts.
- **Non-root containers.** The API, panel (unprivileged nginx), approval
  editor, renderer, demo worker and CPU/GPU workers run as non-root users.
  The one-shot `model-init` image stays root because it writes into the model
  volumes Docker creates as root; it exits before the stack starts.
- **Checksum-verified models.** Model files are pinned to Hugging Face
  revisions and verified against SHA-256 entries in
  `infra/models/model-manifest.json`; a mismatch aborts the install.
- **Uploaded blobs are inert by default.** Only audio, video and raster images
  are served inline after magic-byte validation; every other type (including
  HTML, SVG and XML) is served as an `application/octet-stream` attachment with
  `Content-Security-Policy: sandbox; default-src 'none'` and `nosniff`.
- **No secret endpoint.** `GET /panel/connectors` returns adapter status, never
  credentials. SMTP probes open the greeting without sending mail.
- **History privacy.** The public history is scrubbed of personal paths,
  domains, keys and owner media; see
  [ADR 0007](docs/adr/0007-history-privacy.md). `gitleaks` runs over all refs in
  the final gate.

## What is out of scope

- Attacks that require the operator to publish a debug/internal port to the
  internet, or to run with a modified `.env` that removes the required
  variables.
- Vulnerabilities in a third-party image or model that is not part of this
  repository; report those upstream.
- Denial of service against a local single-user laptop, unless it also affects
  the bundled server defaults.
- The demo fixtures: they are fictional and intentionally deterministic.

## If you find a leaked secret

Do not paste it into an issue. Report it privately as above. The owner rotates
any affected credential; the repository history is rewritten only with explicit
authorization and a fresh backup, following [ADR 0007](docs/adr/0007-history-privacy.md).

## License

This project is released under the MIT license; see [`LICENSE`](LICENSE).
