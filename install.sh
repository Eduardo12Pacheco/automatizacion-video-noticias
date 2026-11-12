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
      --profile <name>      auto (default), cpu or gpu
      --mode <name>         demo (default) or local: real local AI stack
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
PROJECT_DIR_OVERRIDE=""
COMPOSE_FILE_OVERRIDE=""
ADMIN_EMAIL_OVERRIDE=""
MODE_OVERRIDE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) NR_YES=1 ;;
    --profile) REQUESTED_PROFILE="${2:-}"; shift ;;
    --profile=*) REQUESTED_PROFILE="${1#*=}" ;;
    --mode) MODE_OVERRIDE="${2:-}"; shift ;;
    --mode=*) MODE_OVERRIDE="${1#*=}" ;;
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

NR_RUN_MODE="${MODE_OVERRIDE:-${NEWSROOM_MODE:-demo}}"
case "$NR_RUN_MODE" in
  demo|local) ;;
  *) nr_die "unknown mode: $NR_RUN_MODE (expected demo or local)" ;;
esac

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

# --- Check -----------------------------------------------------------------

if [ "$ACTION" = "check" ]; then
  NR_COMPOSE_MISSING_WARN=1
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
  fi
  nr_uninstall "$PURGE"
  exit 0
fi

# --- Install ---------------------------------------------------------------

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

nr_resolve_profile "${REQUESTED_PROFILE:-${NEWSROOM_PROFILE:-auto}}"

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
else
  # A dry run is allowed before the T8 stack exists; it only prints the plan.
  NR_COMPOSE_MISSING_WARN=1
  nr_require_compose || true
  nr_info "would create or repair $NR_ENV_FILE from $NR_ENV_TEMPLATE"
fi

nr_info "installation profile: $NR_PROFILE"
nr_info "run mode: $NR_RUN_MODE"

nr_install_cli "$NR_BIN_DIR"

nr_info "pulling and building images"
nr_run_compose build --pull

nr_download_models
nr_run_migrations
nr_create_admin
nr_start_stack
nr_open_panel

nr_print_generated_admin_password

if [ "$NR_DRY_RUN" = "1" ]; then
  nr_ok "dry-run complete; re-run without --dry-run to install"
else
  nr_ok "installation complete"
fi
