# One Clone, Many Local Services

This repository is the single source tree for the n8n workspace. Before provisioning a new machine, follow the tracked [recovery inventory](docs/recovery/local-artifacts.md); a clone alone is intentionally not operational. Nested repositories have been flattened intentionally; their separate local Git histories are not part of this checkout.

## Local Installation

For the supported end-user path (Docker Compose stack, NVIDIA auto-detection, first administrator and the `newsroom` CLI), see [docs/INSTALL.md](docs/INSTALL.md). The installers are `install.sh` (Linux/macOS) and `install.ps1` (Windows); both are idempotent and generate their own local secrets.

## Quick Path

1. Clone this repository, then use [the recovery inventory](docs/recovery/local-artifacts.md) to obtain every required external artifact from its approved owner.
2. Copy the available sanitized environment templates before configuring a service: `apps/api/.env.example`, `infra/n8n/.env.example`, `services/asr-worker/.env.example`, `services/channel-monitor/.env.example`, `services/renderer/.env.example`, `services/subtitles/.env.example`, and `services/tts-worker/.env.example`.
3. Restore required state and binary assets using the inventory, then start services in the listed order.
4. Verify each local health endpoint or service-specific check before exposing it through any external tunnel or gateway.

The inventory distinguishes repository-proven paths from `REQUIRES PRIVATE INVENTORY` records. Excluded models, media, runtime state, and secrets stay out of Git even when they are necessary to operate a restored machine. Small source-required application assets remain eligible for version control.

## Service Map

| Path | Responsibility | Local operational reference |
|---|---|---|
| `apps/panel/` | Editorial browser panel and local Approval Editor | `apps/panel/README.md` |
| `services/renderer/` | Contract-driven Remotion final renderer | `services/renderer/README.md` |
| `packages/contracts/` | Shared contract helpers | Source tree |
| `services/tts-worker/` | Local GPU-backed TTS worker and orchestrator | `services/tts-worker/README.md` |
| `services/subtitles/` | Remotion subtitles renderer | `services/subtitles/package.json` |
| `services/asr-worker/` | Radar transcription backend (local yt-dlp only) | `services/asr-worker/README.md` |
| `apps/api/` | Authenticated local API gateway | `apps/api/src/` |
| `services/channel-monitor/` | YouTube channel monitoring backend (public RSS by default) | `services/channel-monitor/README.md` |
| `infra/n8n/` | Local Dockerized n8n instance | `infra/n8n/README.md` |
| `infra/windows/` | Windows service helpers | `infra/windows/README.md` |

## Prerequisites

| Requirement | Used by | Evidence / note |
|---|---|---|
| Git | Entire workspace | Required to clone the consolidated source tree. |
| Docker Desktop and Docker Compose | `infra/n8n/` | The compose file runs `n8nio/n8n:1.123.52` on loopback port `5678`. |
| Node.js and pnpm | JavaScript and Remotion services | Root metadata pins `pnpm@11.12.0`; service-specific package manifests define their dependencies. |
| Python | Control Panel checks and Python services | Transcript and Channel Monitor provide Python-based local workflows. |
| NVIDIA/CUDA-capable local environment | Voice TTS when generating speech | The TTS worker is documented as GPU-backed; do not assume this is required for source-only work. |
| ffmpeg and yt-dlp | Transcript workflows | Configurable through `TRANSCRIPT_SERVICE_FFMPEG_BINARY` and `TRANSCRIPT_SERVICE_YT_DLP_BINARY`. |
| External access configured outside Git | Optional public operation | Cloudflare, Supabase, YouTube, and other provider credentials must be supplied as local secrets. |

## Environment And Secrets

Never commit `.env` files, private keys, cookies, API tokens, or credential exports. The root `.gitignore` explicitly keeps `.env.example`, `.env.template`, and the reviewed sanitized n8n workflow exports eligible for version control while ignoring actual environment files and credential exports.

One sanitized historical workflow export is versioned for reference during the
local-first migration. It has placeholders instead of secrets and does not
restore credentials, accounts or an n8n Docker-volume backup. See the
[import limitations](examples/n8n/README.md) before using it.

| Path | Purpose |
|---|---|
| `examples/n8n/workflows.json` | Single historical reference containing all 16 workflow definitions |

The following local credential exports are intentionally untracked and must remain in an encrypted backup location:

| Path | Purpose |
|---|---|
| `infra/n8n/files/credentials-final.json` | n8n credential export |
| `infra/n8n/files/credentials-clean.json` | n8n credential export |
| `infra/n8n/import/credentials.json` | n8n import credential file |

`N8N_ENCRYPTION_KEY` is required to restore n8n credentials. Losing or changing it prevents decryption of the restored credential data.

## Asset Manifest Template

Keep a private, versioned inventory outside Git for every model or binary asset needed to operate this workspace. Do not place secrets in this manifest.

| Asset | Source | Version | SHA-256 | Destination | License | Restore note |
|---|---|---|---|---|---|---|
| `<name>` | `<approved URL or archive>` | `<version>` | `<checksum>` | `<workspace-relative path>` | `<license>` | `<required service>` |

Typical non-Git asset locations include `services/tts-worker/models/`, `services/renderer/projects/`, `services/renderer/public/`, and service runtime/output directories. Product source assets are not ignored solely because of their file extension.

## State Backup And Restore

| State | Source location | Backup requirement | Restore before |
|---|---|---|---|
| n8n Docker volume | Docker volume `n8n_data` | Encrypted volume backup | Starting n8n when historical executions/settings matter |
| n8n encryption key | Local `infra/n8n/.env` | Encrypted secret backup | Importing or reading n8n credentials |
| Sanitized n8n workflow reference | `examples/n8n/workflows.json` | Versioned fixture; review placeholders and external adapters before importing | Inspecting historical workflow definitions |
| n8n credential exports | `infra/n8n/import/credentials.json`, `infra/n8n/files/credentials-clean.json`, `infra/n8n/files/credentials-final.json` | Encrypted backup; never Git | Importing or reading n8n credentials |
| Approval Editor snapshots/audio/output | `apps/panel/services/approval-editor/projects/` | Project-state backup | Opening existing video projects |
| Video render project state/output | `services/renderer/projects/` | Project-state and asset backup | Re-rendering existing projects |
| TTS models, references, output, runtime | `services/tts-worker/` local model/runtime/output paths | Asset plus state backup | TTS startup or reproduction |
| Transcript jobs/runtime | `services/asr-worker/runtime/` | Runtime backup if jobs must survive | Transcript service startup |
| Channel Monitor SQLite/runtime | `services/channel-monitor/runtime/` | Consistent SQLite backup | Channel Monitor startup |

## Restore And Start Order

1. Restore local `.env` files and secrets from an encrypted source. Confirm `N8N_ENCRYPTION_KEY` before importing n8n credentials.
2. Restore required models, binary assets, and persisted service state from the asset and state matrices.
3. Start local n8n from `infra/n8n/` with `docker compose up -d`.
4. Start the local Approval Editor from `apps/panel/` with `node .\services\approval-editor\server.js` when Video Projects are required.
5. Start dependent backend services following their own documented scripts: Transcript Service, Channel Monitor, and TTS as required by the intended workflow.
6. Serve the Control Panel only after its required backend endpoints are available. Its documented local static path is `http://localhost:8080/apps/panel/` when served from the workspace root.
7. Configure or enable external tunnels/gateway exposure only after local checks pass. Do not infer deployed settings from this repository.

## Verification

| Component | Check |
|---|---|
| Root checkout | `git status --short` shows source, docs, and intentional local state separately. |
| n8n | From `infra/n8n/`, use `docker compose logs -f n8n` or `docker compose exec n8n n8n --version`. |
| Approval Editor | `http://127.0.0.1:3042/health` responds when the service is running. |
| Transcript Service | `GET http://127.0.0.1:8765/api/radar/live`; use its authenticated preflight only with a local key. |
| Channel Monitor | Run `services/channel-monitor/scripts/check-service.ps1`; it is the documented safe operational check. |
| TTS | Run `services/tts-worker/scripts/check-services.ps1` when its Windows services are installed. |

## Known Gaps

- This repository does not contain the former nested repositories' individual Git histories.
- Secrets, Docker volumes, models, generated media, local SQLite databases, and runtime projects require an external encrypted backup process.
- External deployment, tunnel, provider, and Supabase configuration must be verified in the active environment; repository files alone are not proof of deployed state.
