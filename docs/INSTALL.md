# Install Newsroom locally

Newsroom runs entirely on your machine. The default installation uses **no API
keys and no cloud accounts**: Postgres, SearXNG, Mailpit, the API, the panel and
the workers run as local containers, and the LLM, speech and transcription
models are downloaded to local volumes.

The installer supports Windows 10/11 (PowerShell 5.1+ and PowerShell 7+) and
Linux (tested on Ubuntu 24.04 and Arch). macOS works with the bash installer on
a best-effort basis.

**What was actually exercised:** the Linux installer and CLI suites run on
`ubuntu-latest` in CI and on the author's Arch/CachyOS machine, including a
fresh-clone demo install and a real CPU local-mode render. The Windows
installer is covered by the `windows-latest` CI job (parser, prerequisite check
and dry-run) and by PowerShell 7 behaviour tests on Linux; it has not been run on
a physical Windows 10/11 desktop. The GPU path was verified for real on an
RTX 4060 8 GB with `nvidia-container-toolkit`: the CUDA smoke image runs, the
local-mode E2E passed with real GPU Ollama, faster-whisper and Qwen3-TTS, and
the measured timings are in [Verified GPU run](#verified-gpu-run).

![Linux guided demo install](images/installer-linux.png)

![Windows installer prerequisite check](images/installer-windows.png)

## Requirements

| Requirement | Linux | Windows |
|---|---|---|
| Docker | Docker Engine + Compose v2 plugin | Docker Desktop with the WSL2 backend (Linux containers) |
| Disk | 10 GB free (more for GPU models) | 10 GB free (more for GPU models) |
| RAM | 8 GB minimum | 8 GB minimum |
| GPU (optional) | NVIDIA driver + `nvidia-container-toolkit` | NVIDIA driver for WSL2 (Docker Desktop detects it) |
| Shell | bash 4+ | PowerShell 5.1 or 7 |

The installer checks all of these before touching the host. `--check` /
`-Check` runs only the checks.

## Quick start (Linux)

```bash
git clone https://github.com/Eduardo12Pacheco/newsroom-video-automation.git
cd newsroom-video-automation
./install.sh
```

The installer:

1. shows a short banner and checks Docker, the daemon, Compose v2, disk, RAM
   and ports;
2. asks for the run mode (`demo` by default, or `local`) and, when an NVIDIA
   GPU is available, whether to use the `gpu` profile;
3. creates `.env` from `.env.example` with fresh random secrets, mode `0600`;
4. installs the `newsroom` CLI into `~/.local/bin` (override with `--bin-dir`);
5. builds the images and, in `local` mode, downloads the models;
6. applies the database migrations;
7. creates the first administrator and prints the generated password once;
8. starts the stack, opens <http://127.0.0.1:8080> and prints a summary box with
   the panel URL, administrator, password and lifecycle commands.

Every phase prints a `[n/7]` progress line. The prompts are skipped by `--yes`,
in CI and when the matching flag (`--mode`, `--gpu`, `--no-gpu`) is present.

## Quick start (Windows)

Open PowerShell in the cloned directory:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

The behaviour is identical to the bash installer. The CLI is installed under
`%LOCALAPPDATA%\Newsroom\bin` as `newsroom.cmd` / `newsroom.ps1`; add that
directory to `PATH` to run `newsroom` from any shell.

If PowerShell blocks the script, run it explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

## Run modes

`NEWSROOM_MODE` selects which real pipeline runs. The installer defaults to
`demo`; pass `--mode local` (bash) or `-Mode local` (PowerShell) for the real
local AI stack. The panel labels the demo run in its header.

| Mode | What runs | Downloads |
|---|---|---|
| `demo` (default) | deterministic stub adapters behind the API; the panel shows **Modo demo / Demo mode** | none |
| `local` | real Ollama script writing, trafilatura extraction, Piper voice, faster-whisper subtitles and a Remotion 720p MP4 on CPU (GPU optional) | Ollama `qwen2.5:3b-instruct` (~2 GB), Whisper `small` (~0.5 GB), Piper `es_ES-davefx-medium` (~60 MB) |

Model downloads only happen in the installer or with `newsroom models pull`;
the Ollama container never downloads a model at start-up. Demo mode skips the
model step entirely.

## Profiles

| Profile | Selected when | Contains |
|---|---|---|
| default/`cpu` | no NVIDIA GPU, or `--profile cpu` / `-Profile cpu` | API, panel, `demo-worker`, Postgres, SearXNG, Mailpit and the deterministic seed; no API keys |
| `local` | `--mode local` (activated through `COMPOSE_PROFILES=local` in `.env`) | the real CPU workers: `ollama`, `asr-worker`, `tts-worker`, `subtitles`, `renderer`, `channel-monitor` |
| `gpu` | `nvidia-smi` reports a GPU and the container runtime is ready | the local stack plus GPU access; the installer and `newsroom up` add `infra/compose/compose.gpu.yaml` automatically so Ollama/ASR/TTS reserve the device and TTS uses Qwen instead of Piper |
| `n8n` | explicit `--profile n8n` | the optional n8n container for `WORKFLOW=n8n` |
| `tools` | never started by `up` | one-shot `migrate` and `model-init` services invoked with `docker compose run --rm` |
| `auto` | default | picks `gpu` or `cpu` as described above |

The demo worker is deliberately deterministic: it serves the TTS, subtitles and
render contracts with small local assets so the browser test can run without a
GPU or a model download. Selecting `local` mode swaps every media route to the
real workers (Piper on CPU, faster-whisper `small` int8, Remotion 720p); the
`gpu` profile only adds GPU access for operators who have it.

### Seed data and the demo story

The unprofiled `seed` service runs after Postgres is healthy and is idempotent.
It creates two fictional users (`editor@example.local` and
`viewer@example.local`, password from the generated `NEWSROOM_DEMO_PASSWORD`),
one pending approval topic and one complete story with a draft and video
project. The administrator account created by the installer is separate and is
the one whose password is printed once; use the administrator for an
interactive login unless `NEWSROOM_DEMO_PASSWORD` was set explicitly before the
install. The E2E environment sets that value so the test can log in as the
editor.

An explicit `--profile gpu` is never silently downgraded. If the container
runtime is missing, the installer warns and `auto` falls back to `cpu`. Install
`nvidia-container-toolkit` (Linux) or update Docker Desktop (Windows) to use the
GPU. The GPU device reservation lives in
`infra/compose/compose.gpu.yaml`, which every installer and CLI Compose call
adds whenever the `gpu` profile is active; a missing overlay is a hard error
instead of a silent CPU fallback.

`newsroom doctor` reports the GPU in two steps: the detected card/runtime, and a
real passthrough probe (`docker run --rm --gpus all
nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L`) when the `gpu` profile is
selected. Override the probe image with `NEWSROOM_GPU_PROBE_IMAGE` on an
air-gapped host.

The GPU install downloads the Qwen3-TTS 1.7B checkpoint (~4.5 GB) in the same
`model-init` step as the Piper/Whisper models. `services/tts-worker/refs/`
ships a 6-second synthetic Piper reference voice so the Qwen engine can clone a
speaker without a recording. Ollama unloads its model immediately on the GPU
(`OLLAMA_GPU_KEEP_ALIVE=0s`, overridable) because the 1.7B Qwen voice and a 3B
LLM cannot stay resident together in 8 GB.

One GPU job runs at a time through `NEWSROOM_GPU_LOCK_PATH`; the API queue keeps
the GPU slot serial.

### Verified GPU run

The `gpu` path was verified on an RTX 4060 8 GB (driver 620.70,
`nvidia-container-toolkit`) with the CUDA smoke image from the doctor check. The
same `e2e/local-mode.spec.js` that runs on CPU passed with real GPU media:

| Stage | GPU | CPU reference |
|---|---|---|
| Ollama script draft | 5.1 s | 22.3 s |
| Piper/Qwen voice | 90.1 s (Qwen3-TTS 1.7B) | 17.8 s (Piper) |
| faster-whisper subtitles | 44.9 s | 46.5 s |
| Remotion render | 188.7 s (CPU) | 177.3 s (CPU) |
| Whole spec | 6.1 min | 5.2 min |

Both columns are the same `e2e/local-mode.spec.js` run on one machine (RTX 4060
8 GB laptop GPU, 12 cores, 31 GB RAM): CPU is the reference and `--gpu` keeps
the Remotion render on CPU. The numbers cover the whole spec from discovery to
the final MP4, not a micro-benchmark.

Peak whole-card usage was 6,646 MB of 8,188 MB (including the desktop), so the
1.7B voice variant is the fitting choice for 8 GB. GPU mode is therefore about
voice quality and LLM speed, not a faster end-to-end run; the render stays on
CPU. The Qwen report records `engine=QwenCloneEngine, device=cuda:0`, and the
Ollama server log records `CUDA0` buffers and `POST /api/chat` responses.

## Non-interactive use

```bash
./install.sh --yes --mode demo --no-gpu
```

```powershell
.\install.ps1 -Yes -Mode demo -NoGpu
```

With `--yes` / `-Yes` the first-admin password is generated and printed exactly
once; it is not written to `.env` or the state file. For automation that must
control the password, provide it through the environment (never through argv):

```bash
NEWSROOM_ADMIN_PASSWORD='choose-a-long-password' ./install.sh --yes --profile cpu
```

Other options:

```text
--mode / -Mode                 demo (default) or local
--profile / -Profile           auto (default), cpu or gpu
--gpu / -Gpu                   use the gpu profile
--no-gpu / -NoGpu              use cpu even when a GPU is present
--port / -Port                 published panel port (default 8080); the
                               localhost origin allow-lists follow it
--no-models / -NoModels        skip the model download
--no-start / -NoStart          prepare the installation without starting it
--no-open / -NoOpen            do not open the panel
--admin-email / -AdminEmail    first administrator email
--project-dir / -ProjectDir    directory holding .env and compose.yaml
--compose-file / -ComposeFile  override the Compose file
--allow-missing-docker / -AllowMissingDocker  CI/self-check only
--version / -Version           installer version
```

`--dry-run` / `-DryRun` prints every action without creating files or starting
containers.

## The `newsroom` CLI

| Command | Behaviour |
|---|---|
| `newsroom up` | build and start the stack |
| `newsroom down` | stop the stack, keep volumes and data |
| `newsroom status` | `docker compose ps` |
| `newsroom logs [service]` | follow logs (`--no-follow` prints and exits) |
| `newsroom update` | refuse a dirty checkout, `git pull --ff-only`, pull/build images, apply migrations, restart |
| `newsroom mode demo\|local` | write the run mode, download models when switching to `local`, restart the stack |
| `newsroom doctor` | Docker, daemon, Compose, GPU, disk, RAM, ports, models, admin and install state |
| `newsroom models [pull]` | download the local models if missing (`pull` forces a refresh) |
| `newsroom test` | run the same suites as CI (`tools/run-all-tests.mjs`) |
| `newsroom version` | CLI version |
| `newsroom help` | usage |

Global options: `--project-dir <path>`, `--profile cpu|gpu`, `--dry-run`.

`doctor` exits non-zero when a blocking check fails, so it can be used in
scripts:

```bash
newsroom doctor || echo "fix the failed checks above"
```

The disk threshold depends on the mode: demo needs 2 GB, local needs 10 GB.
Ports already published by this stack are reported as owned rather than as a
conflict. On filesystems where the free-space or listening-port probe is wrong,
`NEWSROOM_DISK_MB_OVERRIDE` and `NEWSROOM_LISTENING_PORTS_OVERRIDE` (comma
separated) let an operator supply the values; the installer tests use the same
overrides so they never depend on the host.

## First administrator

The first admin is created through the API container, so the password is hashed
with bcrypt before it reaches the database. There is **no default password**.

- Interactive install: the installer asks for the email and a password (minimum
  8 characters).
- `--yes` / `-Yes`: a random password is generated and printed once.
- Administrator management afterwards: the **Usuarios** screen (admin role) or
  the API's `/panel/admin/users` endpoints. Roles are `admin`, `editor` and
  `viewer`, enforced server-side.

If you lose the password, reset it from the checkout:

```bash
printf '%s' 'new-long-password' | docker compose run --rm -T api \
  node scripts/create-admin.js --email admin@example.local --password-stdin --reset-password
```

## Updating and uninstalling

```bash
newsroom update
```

Re-running `install.sh` / `install.ps1` is also safe: existing secrets are kept,
downloads and migrations are skipped when the state says they are done, and the
stack is rebuilt/restarted. The administrator password is not reset.

Stop and remove containers but keep data:

```bash
./install.sh --uninstall
```

Remove containers **and** volumes, models, images and `.env`. Destructive
purges always ask you to type `delete`, even when `--yes` is present; use
`--force-purge` / `-ForcePurge` only for unattended automation:

```bash
./install.sh --uninstall --purge
./install.sh --uninstall --purge --force-purge   # no prompt
```

```powershell
.\install.ps1 -Uninstall -Purge
.\install.ps1 -Uninstall -Purge -ForcePurge       # no prompt
```

## Opening the panel to the LAN

Only the panel and API ports are published, and `NEWSROOM_BIND` controls
their host interface (`127.0.0.1` by default). `.env.example` keeps
`API_GATEWAY_HOST=0.0.0.0` so the API listens on the Compose network for the
panel's nginx proxy; it is not published to the host directly. To let other
people on your LAN use the panel:

1. Set `NEWSROOM_BIND=0.0.0.0` (or your LAN address) in `.env`.
2. Add the LAN origin to `API_GATEWAY_ALLOWED_ORIGINS` and
   `API_GATEWAY_TRUSTED_MUTATION_ORIGINS`.
3. Allow the panel port through the host firewall.
4. Open `http://<your-lan-ip>:8080`.

> **Plain HTTP on a LAN is for trusted networks only.** The session cookie is
> HTTP-only and SameSite=Lax, and becomes `Secure` automatically only when the
> API sees HTTPS (directly, or through the trusted panel proxy's
> `X-Forwarded-Proto`). Anyone who can observe the LAN traffic can read the
> session token over plain HTTP.

### Optional HTTPS (recommended for shared networks)

Keep the stack loopback-bound and put a TLS terminator you control in front of
the panel. For example, with Caddy on the same host:

```caddyfile
newsroom.example.lan {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy obtains or uses a local certificate and proxies HTTPS to the panel. The
panel forwards the HTTPS scheme to the API, which marks the session cookie
`Secure`; regenerate the browser session by logging in again after switching
from HTTP to HTTPS. An nginx terminator works the same way as long as it sends
`X-Forwarded-Proto: https`. Do not accept that header from untrusted clients:
only place the panel behind a reverse proxy you operate.

Postgres, Ollama, SearXNG, Mailpit and n8n are not published. For debugging,
add the optional override:

```bash
docker compose -f compose.yaml -f infra/compose/compose.debug.yaml up
```

Sessions are HTTP-only, SameSite=Lax cookies with a server-side store and
expiry. Login attempts are rate-limited. Do not expose the stack to the public
internet.

## Running Compose without the installer

`docker compose up` alone fails by design on a fresh clone: the stack needs
generated secrets and a panel proxy network, and Compose stops with a
`run ./install.sh first ...` message when `.env` is missing. Run the installer
once (`./install.sh` / `.\install.ps1`), or start Compose with a complete
environment file:

```bash
docker compose --env-file path/to/complete.env up -d
```

`compose.yaml` interpolates the required variables and the `:?` messages in the
file carry the same hint. This is intentional: silently falling back to weak
defaults would ship an insecure installation.

## Configuration

Everything is read from `.env`, generated from [`.env.example`](../.env.example).
Useful values:

| Variable | Default | Meaning |
|---|---|---|
| `NEWSROOM_PROFILE` | `cpu` | Written by the installer; `cpu` or `gpu` |
| `PANEL_PORT` / `API_GATEWAY_PORT` | `8080` / `8099` | Host ports |
| `NEWSROOM_BIND` | `127.0.0.1` | Host interface for the published panel/API ports |
| `NEWSROOM_PANEL_SUBNET` / `NEWSROOM_PANEL_IP` | installer-chosen free `/24` and `.10` | Dedicated panel proxy network and fixed panel address |
| `TRUSTED_PROXY_CIDRS` | `<NEWSROOM_PANEL_IP>/32` | Panel container address allowed to set `X-Forwarded-For` |
| `DATABASE_URL` | local Postgres | Repository connection string |
| `LLM` | `ollama` | Local model adapter; `openai` is optional and off by default |
| `OLLAMA_MODEL` | `qwen2.5:3b-instruct` | Local Spanish-capable model |
| `ARTICLE_EXTRACTOR` | `trafilatura` | Local article extraction |
| `IMAGE_SEARCH` | `searxng` | Local image search, Wikimedia fallback |
| `NOTIFY` | `console` | Local notifications; `smtp` uses Mailpit/Gmail |
| `WORKFLOW` | `disabled` | Optional n8n orchestration profile |
| `TTS_WORKER_ENGINE` | `piper` | Piper on CPU; the `gpu` overlay selects Qwen |
| `WHISPER_MODEL` | `small` | faster-whisper model |

Secrets generated by the installer are 48 hex characters and unique per key.
Do not commit `.env`. Do not put real API keys in `.env.example`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `docker is not installed or not in PATH` | Install Docker Engine/Desktop and reopen the shell. On Windows use the WSL2 backend. |
| `docker daemon is not reachable` | Start Docker Desktop or `sudo systemctl start docker`. |
| `compose file not found` | The Compose stack is not present in this checkout; see [the Compose contract](../infra/install/COMPOSE_CONTRACT.md). |
| `docker compose ... run --rm model-init` fails | Free disk space, then re-run; the step is idempotent. |
| Port already in use | Change `PANEL_PORT`/`API_GATEWAY_PORT`/etc. in `.env` and re-run `newsroom up`. |
| GPU not used | Run `nvidia-smi`, install `nvidia-container-toolkit`, then `./install.sh --profile gpu`. |
| Panel cannot reach the API | Check `API_GATEWAY_ALLOWED_ORIGINS` and the panel's API origin. |
| Login fails after a fresh install | The generated password was printed once. Reset it with the command in [First administrator](#first-administrator). |

Collect diagnostics with:

```bash
newsroom doctor
docker compose ps
docker compose logs --tail=200 api
```

## Verification in this repository

The installer logic is covered by `infra/install/tests` through the public
commands, using a deterministic `docker` stand-in:

```bash
bash infra/install/tests/run.sh
```

The suite also runs the Windows scripts with PowerShell 7 when `pwsh` is
available. The CI workflow `.github/workflows/installers.yml` runs the checks on
`ubuntu-latest` and `windows-latest`; the Windows job keeps Docker optional
because the hosted runner does not provide Linux containers.

## End-to-end check

The default stack ships the Playwright happy path:

```bash
export NEWSROOM_ENV_FILE=e2e/.env.example
export E2E_COMPOSE_ENV=e2e/.env.example
docker compose --env-file "$E2E_COMPOSE_ENV" up -d --build postgres searxng mailpit demo-worker api panel
docker compose --env-file "$E2E_COMPOSE_ENV" run --rm seed
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
E2E_ALLOW_RESET=1 pnpm exec playwright test e2e/happy-path.spec.js e2e/panel-flows.spec.js
```

Do not copy `e2e/.env.example` over an installed `.env`: it replaces the
installer-generated secrets. Pass the E2E file with `--env-file` as shown.
`E2E_ALLOW_RESET=1` authorizes the destructive panel-flow reset and must only
be used against a disposable demo stack created for the E2E suite.

Use `docker compose down -v` between runs. The test logs in through the UI,
approves a topic, waits for the drafted script, publishes it and checks voice,
subtitles and final render artifacts through the panel proxy. See
[e2e/README.md](../e2e/README.md).

The Compose contract is documented in
[COMPOSE_CONTRACT.md](../infra/install/COMPOSE_CONTRACT.md).
