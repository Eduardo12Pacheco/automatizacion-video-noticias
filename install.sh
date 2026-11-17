#!/usr/bin/env bash
# Newsroom local installer (Linux and macOS; Windows uses install.ps1).
#
# Idempotent: re-running repairs the stack and upgrades images without touching
# generated secrets or resetting the administrator password.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/install/lib/common.sh
. "$SCRIPT_DIR/infra/install/lib/common.sh"

usage() {
  cat <<'EOF'
Newsroom local installer

Usage:
  ./install.sh [options]

Options:
  -y, --yes                 Non-interactive; generate the admin password
      --mode <name>         demo (default) or local: real local AI stack
      --profile <name>      auto (default), cpu or gpu
      --gpu                 Use the gpu profile
      --no-gpu              Use the cpu profile even when a GPU is present
      --port <number>       Published panel port (default 8080)
      --check               Check host prerequisites and exit
      --dry-run             Print every action without changing the host
      --uninstall           Stop and remove the stack
      --purge               With --uninstall: also delete volumes, models and .env
      --force-purge         Skip the typed purge confirmation (non-interactive use)
      --no-models           Skip downloading the local models
      --no-start            Prepare the installation but do not start the stack
      --no-open             Do not open the panel in a browser
      --bin-dir <path>      Where to install the `newsroom` CLI
      --admin-email <email> First administrator email
      --project-dir <path>  Directory holding .env and compose.yaml
      --compose-file <path> Docker Compose file
      --allow-missing-docker  Warn instead of failing when Docker is absent
  -h, --help                Show this help
      --version             Show the installer version

Environment:
  NEWSROOM_MODE, NEWSROOM_PROFILE, NEWSROOM_PROJECT_DIR, NEWSROOM_COMPOSE_FILE,
  NEWSROOM_ADMIN_EMAIL, NEWSROOM_ADMIN_PASSWORD, NEWSROOM_BIN_DIR

The installer never reads or writes API keys. It creates .env from
.env.example with fresh random secrets (mode 0600) and installs the first
administrator through the API container.
EOF
}

# --- Argument parsing ------------------------------------------------------

ACTION=install
PURGE=0
REQUESTED_PROFILE=""
PROFILE_EXPLICIT=0
PROJECT_DIR_OVERRIDE=""
COMPOSE_FILE_OVERRIDE=""
ADMIN_EMAIL_OVERRIDE=""
MODE_OVERRIDE=""
MODE_EXPLICIT=0
PORT_OVERRIDE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) NR_YES=1 ;;
    --profile)
      if [ "$PROFILE_EXPLICIT" = "1" ] && [ -n "$REQUESTED_PROFILE" ] && [ "$REQUESTED_PROFILE" != "${2:-}" ]; then
        nr_die "--profile ${2:-} conflicts with the earlier --profile $REQUESTED_PROFILE"
      fi
      REQUESTED_PROFILE="${2:-}"
      PROFILE_EXPLICIT=1
      shift ;;
    --profile=*) REQUESTED_PROFILE="${1#*=}"; PROFILE_EXPLICIT=1 ;;
    --gpu)
      if [ "$PROFILE_EXPLICIT" = "1" ] && [ "$REQUESTED_PROFILE" != "gpu" ] && [ "$REQUESTED_PROFILE" != "auto" ]; then
        nr_die "--gpu conflicts with --profile $REQUESTED_PROFILE"
      fi
      REQUESTED_PROFILE=gpu
      PROFILE_EXPLICIT=1 ;;
    --no-gpu)
      if [ "$PROFILE_EXPLICIT" = "1" ] && [ "$REQUESTED_PROFILE" != "cpu" ] && [ "$REQUESTED_PROFILE" != "auto" ]; then
        nr_die "--no-gpu conflicts with --profile $REQUESTED_PROFILE"
      fi
      REQUESTED_PROFILE=cpu
      PROFILE_EXPLICIT=1 ;;
    --mode) MODE_OVERRIDE="${2:-}"; MODE_EXPLICIT=1; shift ;;
    --mode=*) MODE_OVERRIDE="${1#*=}"; MODE_EXPLICIT=1 ;;
    --port) PORT_OVERRIDE="${2:-}"; shift ;;
    --port=*) PORT_OVERRIDE="${1#*=}" ;;
    --check) ACTION=check ;;
    --dry-run) NR_DRY_RUN=1 ;;
    --uninstall) ACTION=uninstall ;;
    --purge) PURGE=1 ;;
    --force-purge) PURGE=1; NR_FORCE_PURGE=1 ;;
    --no-models) NR_DOWNLOAD_MODELS=0 ;;
    --no-start) NR_START_STACK=0 ;;
    --no-open) NR_OPEN_PANEL=0 ;;
    --open) NR_OPEN_PANEL=1 ;;
    --bin-dir) NR_BIN_DIR="${2:-}"; shift ;;
    --bin-dir=*) NR_BIN_DIR="${1#*=}" ;;
    --admin-email) ADMIN_EMAIL_OVERRIDE="${2:-}"; shift ;;
    --admin-email=*) ADMIN_EMAIL_OVERRIDE="${1#*=}" ;;
    --project-dir) PROJECT_DIR_OVERRIDE="${2:-}"; shift ;;
    --project-dir=*) PROJECT_DIR_OVERRIDE="${1#*=}" ;;
    --compose-file) COMPOSE_FILE_OVERRIDE="${2:-}"; shift ;;
    --compose-file=*) COMPOSE_FILE_OVERRIDE="${1#*=}" ;;
    --allow-missing-docker) NR_ALLOW_MISSING_DOCKER=1 ;;
    -h|--help) usage; exit 0 ;;
    --version) printf 'newsroom installer %s\n' "${NEWSROOM_VERSION:-0.1.0}"; exit 0 ;;
    *) nr_die "unknown argument: $1 (use --help)" ;;
  esac
  shift
done

if [ -n "$PROJECT_DIR_OVERRIDE" ]; then
  NR_PROJECT_DIR="$PROJECT_DIR_OVERRIDE"
fi
if [ -n "$COMPOSE_FILE_OVERRIDE" ]; then
  NEWSROOM_COMPOSE_FILE="$COMPOSE_FILE_OVERRIDE"
fi
nr_reinit_paths
NR_PORT_OVERRIDE="$PORT_OVERRIDE"

if [ -n "$NR_PORT_OVERRIDE" ]; then
  case "$NR_PORT_OVERRIDE" in
    ''|*[!0-9]*) nr_die "invalid --port: $NR_PORT_OVERRIDE (expected 1-65535)" ;;
  esac
  if [ "$NR_PORT_OVERRIDE" -lt 1 ] || [ "$NR_PORT_OVERRIDE" -gt 65535 ]; then
    nr_die "invalid --port: $NR_PORT_OVERRIDE (expected 1-65535)"
  fi
fi

if [ -z "$MODE_OVERRIDE" ] && [ -n "${NEWSROOM_MODE:-}" ]; then
  MODE_OVERRIDE="$NEWSROOM_MODE"
  MODE_EXPLICIT=1
fi
if [ -z "$REQUESTED_PROFILE" ] && [ -n "${NEWSROOM_PROFILE:-}" ]; then
  REQUESTED_PROFILE="$NEWSROOM_PROFILE"
  PROFILE_EXPLICIT=1
fi

if [ -n "$ADMIN_EMAIL_OVERRIDE" ]; then
  NEWSROOM_ADMIN_EMAIL="$ADMIN_EMAIL_OVERRIDE"
  export NEWSROOM_ADMIN_EMAIL
fi

if [ -z "$NR_BIN_DIR" ]; then
  if [ -n "${NEWSROOM_BIN_DIR:-}" ]; then
    NR_BIN_DIR="$NEWSROOM_BIN_DIR"
  elif [ -n "${HOME:-}" ] && [ -d "$HOME/.local/bin" ]; then
    NR_BIN_DIR="$HOME/.local/bin"
  elif [ -n "${HOME:-}" ]; then
    NR_BIN_DIR="$HOME/.local/bin"
  else
    NR_BIN_DIR="$NR_PROJECT_DIR/bin"
  fi
fi

if [ "$NR_OPEN_PANEL" = "0" ] && [ "$ACTION" = "install" ] && [ "$NR_YES" = "0" ] && [ -t 0 ]; then
  NR_OPEN_PANEL=1
fi

nr_print_header
if [ "$NR_DRY_RUN" = "1" ]; then
  nr_info "dry-run: no files, containers, volumes or models will be changed"
fi

# Guided choices. Explicit flags, --yes, CI and non-interactive shells
# skip the prompts and keep the documented defaults.
if [ "$ACTION" = "install" ] && [ "$MODE_EXPLICIT" = "0" ] && [ "$NR_DRY_RUN" = "0" ] && nr_is_interactive; then
  nr_prompt_mode
  MODE_OVERRIDE="$NR_RUN_MODE"
fi

NR_RUN_MODE="${MODE_OVERRIDE:-demo}"
case "$NR_RUN_MODE" in
  demo|local) ;;
  *) nr_die "unknown mode: $NR_RUN_MODE (expected demo or local)" ;;
esac

# --- Check -----------------------------------------------------------------

if [ "$ACTION" = "check" ]; then
  NR_COMPOSE_MISSING_WARN=1
  if [ "$MODE_EXPLICIT" = "0" ] && [ -f "$NR_ENV_FILE" ]; then
    env_mode="$(nr_env_get NEWSROOM_MODE)"
    [ -n "$env_mode" ] && NR_RUN_MODE="$env_mode"
    unset env_mode
  fi
  if nr_check_environment; then
    exit 0
  fi
  exit 1
fi

# --- Uninstall -------------------------------------------------------------

if [ "$ACTION" = "uninstall" ]; then
  if [ -f "$NR_ENV_FILE" ]; then
    NR_PROFILE="$(nr_env_get NEWSROOM_PROFILE)"
    NR_PROFILE="${NR_PROFILE:-auto}"
    NR_RUN_MODE="$(nr_env_get NEWSROOM_MODE)"
    NR_RUN_MODE="${NR_RUN_MODE:-demo}"
  fi
  nr_uninstall "$PURGE"
  exit 0
fi

# --- Install ---------------------------------------------------------------

nr_step 1 7 "Checking Docker, host requirements and ports"
if [ "$NR_ALLOW_MISSING_DOCKER" = "1" ] && [ "$NR_DRY_RUN" = "1" ]; then
  nr_info "docker checks skipped (--allow-missing-docker with --dry-run)"
else
  if ! nr_docker_cli_ok; then
    nr_die "docker is not installed or not in PATH"
  fi
  if ! nr_docker_daemon_ok; then
    nr_die "docker daemon is not reachable; start Docker Desktop or the docker service"
  fi
  if ! nr_compose_cli_ok; then
    nr_die "the docker compose v2 plugin is required"
  fi
fi

if [ "$PROFILE_EXPLICIT" = "0" ] && [ "$NR_DRY_RUN" = "0" ] && nr_is_interactive; then
  nr_prompt_profile
fi
nr_resolve_profile "${REQUESTED_PROFILE:-${NR_PROFILE:-auto}}"

nr_step 2 7 "Preparing the environment file and run mode"
if [ "$NR_DRY_RUN" = "0" ]; then
  nr_require_compose
  nr_env_ensure
  nr_env_set NEWSROOM_PROFILE "$NR_PROFILE"
  nr_env_set NEWSROOM_MODE "$NR_RUN_MODE"
  if [ "$NR_RUN_MODE" = "local" ]; then
    nr_env_set COMPOSE_PROFILES "local"
  else
    nr_env_set COMPOSE_PROFILES ""
  fi
  if [ -n "$ADMIN_EMAIL_OVERRIDE" ]; then
    nr_env_set NEWSROOM_ADMIN_EMAIL "$ADMIN_EMAIL_OVERRIDE"
  fi
  if [ -n "$NR_PORT_OVERRIDE" ]; then
    nr_env_set PANEL_PORT "$NR_PORT_OVERRIDE"
    nr_env_apply_panel_port "$NR_PORT_OVERRIDE"
  fi
  # On CPU the local product uses Piper; auto would require a reference
  # transcript for the Qwen path before it can fall back.
  if [ "$NR_RUN_MODE" = "local" ] && [ "$NR_PROFILE" != "gpu" ]; then
    tts_engine="$(nr_env_get TTS_WORKER_ENGINE)"
    if [ -z "$tts_engine" ] || [ "$tts_engine" = "auto" ]; then
      nr_env_set TTS_WORKER_ENGINE piper
    fi
  fi
  # The GPU voice model and a 3B LLM cannot stay resident together in 8 GB.
  # The API sends keep_alive per request, so the unload policy has to live in
  # the env file as well as in the compose overlay.
  if [ "$NR_PROFILE" = "gpu" ]; then
    nr_env_set TTS_WORKER_ENGINE qwen
    nr_env_set OLLAMA_KEEP_ALIVE "0s"
  fi
else
  # A dry run is allowed before the stack exists; it only prints the plan.
  NR_COMPOSE_MISSING_WARN=1
  nr_require_compose || true
  nr_info "would create or repair $NR_ENV_FILE from $NR_ENV_TEMPLATE"
fi

nr_info "installation profile: $NR_PROFILE"
nr_info "run mode: $NR_RUN_MODE"

nr_step 3 7 "Installing the newsroom control CLI"
nr_install_cli "$NR_BIN_DIR"

nr_step 4 7 "Pulling and building container images"
nr_run_compose build --pull

nr_step 5 7 "Preparing local models"
nr_download_models

nr_step 6 7 "Applying migrations and creating the administrator"
nr_run_migrations
nr_create_admin

nr_step 7 7 "Starting the stack"
nr_start_stack
nr_open_panel

nr_print_summary

if [ "$NR_DRY_RUN" = "1" ]; then
  nr_ok "dry-run complete; re-run without --dry-run to install"
else
  nr_ok "installation complete"
fi
