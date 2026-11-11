# One Clone, Many Local Services

This repository is the single source tree for the n8n workspace. Before provisioning a new machine, follow the tracked [recovery inventory](docs/recovery/local-artifacts.md); a clone alone is intentionally not operational. Nested repositories have been flattened intentionally; their separate local Git histories are not part of this checkout.

## Quick Path

1. Clone this repository, then use [the recovery inventory](docs/recovery/local-artifacts.md) to obtain every required external artifact from its approved owner.
2. Copy the available sanitized environment templates before configuring a service: `local/n8n/.env.example`, `05-Voice-TTS-Service/.env.local.example`, `09-Transcript-Service/.env.example`, and `10-Channel-Monitor-Service/.env.example`.
3. Restore required state and binary assets using the inventory, then start services in the listed order.
4. Verify each local health endpoint or service-specific check before exposing it through any external tunnel or gateway.

The inventory distinguishes repository-proven paths from `REQUIRES PRIVATE INVENTORY` records. Excluded models, media, runtime state, and secrets stay out of Git even when they are necessary to operate a restored machine. Small source-required application assets remain eligible for version control.

## Service Map

| Path | Responsibility | Local operational reference |
|---|---|---|
| `01-Control-Panel/` | Editorial browser panel and local Approval Editor | `01-Control-Panel/README.md` |
| `02-Video-Engine/` | Contract-driven Remotion final renderer | `02-Video-Engine/README.md` |
| `03-Contracts-Core/` | Shared contract helpers | Source tree |
| `04-Image-Downloader/` | Reserved path for the former Image Downloader service | Source was not present in this checkout; restore it from its canonical backup before enabling it. |
| `05-Voice-TTS-Service/` | Local GPU-backed TTS worker and orchestrator | `05-Voice-TTS-Service/README.md` |
| `06-Subtitles-Service/` | Remotion subtitles renderer | `06-Subtitles-Service/package.json` |
| `07-Supabase/` | Reserved path for Supabase configuration and migrations | Configuration and migrations were not present in this checkout; restore them from the canonical Supabase backup before relying on them. |
| `08-Workspace-Docs/` | Workspace operational documentation | Source tree |
| `09-Transcript-Service/` | Radar transcription backend | `09-Transcript-Service/README.md` |
| `10-Api-Gateway/` | Authenticated local API gateway | `10-Api-Gateway/src/` |
| `10-Channel-Monitor-Service/` | YouTube channel monitoring backend | `10-Channel-Monitor-Service/README.md` |
| `11-Remote-Fetcher/` | Remote fetch boundary service | `11-Remote-Fetcher/README.md` |
| `12-Channel-Network-Boundary/` | Channel network boundary service | `12-Channel-Network-Boundary/README.md` |
| `local/n8n/` | Local Dockerized n8n instance | `local/n8n/README.md` |
| `local/services/` | Windows service helpers | `local/services/README.md` |

## Prerequisites

| Requirement | Used by | Evidence / note |
|---|---|---|
| Git | Entire workspace | Required to clone the consolidated source tree. |
| Docker Desktop and Docker Compose | `local/n8n/` | The compose file runs `n8nio/n8n:1.123.52` on loopback port `5678`. |
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
| `local/n8n/files/credentials-final.json` | n8n credential export |
| `local/n8n/files/credentials-clean.json` | n8n credential export |
| `local/n8n/import/credentials.json` | n8n import credential file |

`N8N_ENCRYPTION_KEY` is required to restore n8n credentials. Losing or changing it prevents decryption of the restored credential data.

## Asset Manifest Template

Keep a private, versioned inventory outside Git for every model or binary asset needed to operate this workspace. Do not place secrets in this manifest.

| Asset | Source | Version | SHA-256 | Destination | License | Restore note |
|---|---|---|---|---|---|---|
| `<name>` | `<approved URL or archive>` | `<version>` | `<checksum>` | `<workspace-relative path>` | `<license>` | `<required service>` |

Typical non-Git asset locations include `local/models/`, `05-Voice-TTS-Service/models/`, `02-Video-Engine/projects/`, `02-Video-Engine/public/`, and service runtime/output directories. Product source assets are not ignored solely because of their file extension.

## State Backup And Restore

| State | Source location | Backup requirement | Restore before |
|---|---|---|---|
| n8n Docker volume | Docker volume `n8n_data` | Encrypted volume backup | Starting n8n when historical executions/settings matter |
| n8n encryption key | Local `local/n8n/.env` | Encrypted secret backup | Importing or reading n8n credentials |
| Sanitized n8n workflow reference | `examples/n8n/workflows.json` | Versioned fixture; review placeholders and external adapters before importing | Inspecting historical workflow definitions |
| n8n credential exports | `local/n8n/import/credentials.json`, `local/n8n/files/credentials-clean.json`, `local/n8n/files/credentials-final.json` | Encrypted backup; never Git | Importing or reading n8n credentials |
| Approval Editor snapshots/audio/output | `01-Control-Panel/services/approval-editor/projects/` | Project-state backup | Opening existing video projects |
| Video render project state/output | `02-Video-Engine/projects/` | Project-state and asset backup | Re-rendering existing projects |
| TTS models, references, output, runtime | `05-Voice-TTS-Service/` local model/runtime/output paths | Asset plus state backup | TTS startup or reproduction |
| Transcript jobs/runtime | `09-Transcript-Service/runtime/` | Runtime backup if jobs must survive | Transcript service startup |
| Channel Monitor SQLite/runtime | `10-Channel-Monitor-Service/runtime/` | Consistent SQLite backup | Channel Monitor startup |

## Restore And Start Order

1. Restore local `.env` files and secrets from an encrypted source. Confirm `N8N_ENCRYPTION_KEY` before importing n8n credentials.
2. Restore required models, binary assets, and persisted service state from the asset and state matrices.
3. Start local n8n from `local/n8n/` with `docker compose up -d`.
4. Start the local Approval Editor from `01-Control-Panel/` with `node .\services\approval-editor\server.js` when Video Projects are required.
5. Start dependent backend services following their own documented scripts: Transcript Service, Channel Monitor, and TTS as required by the intended workflow.
6. Serve the Control Panel only after its required backend endpoints are available. Its documented local static path is `http://localhost:8080/01-Control-Panel/` when served from the workspace root.
7. Configure or enable external tunnels/gateway exposure only after local checks pass. Do not infer deployed settings from this repository.

## Verification

| Component | Check |
|---|---|
| Root checkout | `git status --short` shows source, docs, and intentional local state separately. |
| n8n | From `local/n8n/`, use `docker compose logs -f n8n` or `docker compose exec n8n n8n --version`. |
| Approval Editor | `http://127.0.0.1:3042/health` responds when the service is running. |
| Transcript Service | `GET http://127.0.0.1:8765/api/radar/live`; use its authenticated preflight only with a local key. |
| Channel Monitor | Run `10-Channel-Monitor-Service/scripts/check-service.ps1`; it is the documented safe operational check. |
| TTS | Run `05-Voice-TTS-Service/scripts/check-services.ps1` when its Windows services are installed. |

## Known Gaps

- This repository does not contain the former nested repositories' individual Git histories.
- Secrets, Docker volumes, models, generated media, local SQLite databases, and runtime projects require an external encrypted backup process.
- Not every service provides a root-level bootstrap command or a sanitized environment template.
- `04-Image-Downloader/` and `07-Supabase/` contain no recoverable application source/configuration in this checkout; obtain their canonical backups separately if those capabilities are required.
- External deployment, tunnel, provider, and Supabase configuration must be verified in the active environment; repository files alone are not proof of deployed state.
