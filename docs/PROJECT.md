# Project background and scope

The background that does not fit in the [README](../README.md): where the
project came from, what is and is not verified, the technology choices and a map
of the repository.

## Project story

The original version of this product ran for about three months in a real
newsroom, with n8n as the backend, Supabase as the datastore and several paid
API keys for extraction, search and language models. It proved the workflow and
taught the expensive lesson: the interesting part was the editorial pipeline,
not the cloud accounts.

This repository is a ground-up rebuild of that system. The domain rules moved
from n8n Code nodes into tested use cases, the browser stopped talking to
Supabase, duplicate Whisper/RSS/download code was collapsed, the UI was rebuilt
around a design system, and every external capability became an optional
adapter behind a local-first default. The private deployment is not running and
is not linked from here.

The rebuild was implemented by an autonomous coding agent from a reviewed
feature document, with tests, local verification and human review at the
decision points.

## Honest scope

- This repository is a **portfolio rebuild**, not a live system. It is designed
  to be installed and run locally; nothing is deployed to the internet.
- Both run modes are real and tested: `demo` is deterministic and needs no
  models; `local` runs the actual local models and produces real media on CPU.
  The recorded demo is the demo mode, and the panel labels it as such.
- Linux is tested on the CI `ubuntu-latest` runner and on the owner's
  Arch/CachyOS machine. The Windows installer is covered by the
  `windows-latest` CI job (parser, prerequisite check and dry-run) and by
  PowerShell 7 behaviour tests on Linux; it has not been exercised on a
  physical Windows 10/11 desktop.
- GPU mode is verified on the owner's machine (RTX 4060 8 GB, driver 620.70,
  `nvidia-container-toolkit`): `docker run --rm --gpus all
  nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` works, and the local-mode E2E
  passed with real CUDA Ollama, faster-whisper and Qwen3-TTS media. Peak GPU
  memory during that run was 6,646 MB of 8,188 MB; the 1.7B voice variant fits
  because the LLM unloads immediately and GPU jobs are serialized. GPU mode is
  not faster end to end than CPU (Qwen synthesis is heavier and the Remotion
  render stays on CPU): the measured run took 6.1 min versus 5.2 min on CPU,
  while the LLM draft dropped from 22.3 s to 5.1 s. See
  [Verified GPU run](INSTALL.md#verified-gpu-run).
- The UI chrome, navigation, admin area and every screen in the visual-QA suite
  are translated in ES/EN. Generated editorial content (news titles, scripts,
  player names) intentionally stays in its source language.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| UI | Vanilla HTML, CSS and ES modules | No build step, easy to inspect in the browser |
| API | Node.js in `apps/api` | One backend owns auth, sessions, read models and the job queue |
| Domain | `packages/core` use cases + `packages/contracts` | The original n8n rules are ordinary, tested code |
| Data | Postgres 16 + tracked SQL migrations | Same engine as Supabase, self-hosted and disposable in tests |
| Local AI | Ollama, trafilatura, faster-whisper, Piper/Qwen | Runs on one machine, with CPU fallbacks |
| Video | Remotion | Programmatic, role-based brand compositions |
| Packaging | Docker Compose + `install.sh` / `install.ps1` + `newsroom` CLI | One install path for Linux and Windows |

The reasoning behind the main choices is recorded in the [ADRs](adr/).

## Repository map

```text
apps/
  api/                 HTTP API, auth, sessions, job queue, composition root
  panel/               Vanilla ES-module editorial UI
packages/
  contracts/           Shared contract helpers and editor schemas
  core/                Use cases and ports (the domain)
  data/                Repository + blob ports, Postgres/in-memory/S3 adapters
  adapters/            Local-first adapters and the optional connectors
services/
  asr-worker/          faster-whisper GPU/CPU service, yt-dlp download
  tts-worker/          Piper CPU + Qwen GPU TTS
  renderer/            Remotion final renderer
  subtitles/           Caption alignment and burn-in
  channel-monitor/     Public RSS channel monitoring
  demo-worker/         Deterministic keyless worker for the demo profile
infra/
  db/migrations/       Tracked SQL schema
  n8n/                 Optional n8n profile and two slim workflows
  install/             Shared installer library and tests
  windows/             Optional Windows service helpers
docs/                  Architecture, ADRs, install, connectors, data model
examples/              Fictional brand assets and the legacy n8n reference
tools/                 Asset generator, demo recorder and structural tests
```

[docs/ARCHITECTURE.md](ARCHITECTURE.md#code-boundaries) describes what each
path is responsible for and what it may depend on.

## Testing snapshot

```bash
pnpm install --frozen-lockfile
pnpm test:all
```

`pnpm test:all` runs the same suites CI runs and prints a summary table. It
covers every Node package, the panel pytest suite and its 42 `__checks__`
scripts, each Python service, the tools tests, installer tests and the Compose
config: **28 of 30 suites pass, 0 failures, 2 allow-listed skips** on the
revision this was written against. The two skips are the demo E2E and the
local-mode E2E, which need a running stack; CI runs both in their own jobs, and
`e2e/local-mode.spec.js` downloads the real models and asserts the rendered
audio, subtitles and MP4 with `ffprobe`. The visual-QA suite runs without Docker
against the showcase. Every suite is blocking in CI; there are no
`continue-on-error` baselines.

Focused examples:

```bash
pnpm test:panel
pnpm test:checks
node --test apps/api/test
uv run --project services/asr-worker --with pytest --with httpx pytest services/asr-worker/tests -q
pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js
```

The full test matrix and conventions are in [CONTRIBUTING.md](../CONTRIBUTING.md);
the browser E2E setup is in [e2e/README.md](../e2e/README.md).

## Security at a glance

Published ports bind to `127.0.0.1` by default, users live in Postgres with
bcrypt hashes and HTTP-only sessions, and every mutating route passes one role
gate with a trusted-Origin check. Uploaded blobs are served with a sandbox CSP
and `nosniff`; only audio, video and raster images may render inline, while
HTML, SVG and XML are forced to `application/octet-stream` downloads. The full
list and the threat model are in [SECURITY.md](../SECURITY.md).
