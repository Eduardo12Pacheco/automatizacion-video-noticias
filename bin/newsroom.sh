#!/usr/bin/env bash
# Newsroom control CLI: thin wrapper over docker compose for one checkout.
#
# Installed by install.sh as `newsroom` (see docs/INSTALL.md). It deliberately
# contains no business logic beyond path/state resolution and the one-GPU-safe
# stack lifecycle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../infra/install/lib/common.sh
. "$SCRIPT_DIR/../infra/install/lib/common.sh"

usage() {
  cat <<'EOF'
Newsroom control CLI

Usage:
  newsroom <command> [options]

Commands:
  up                 Build and start the stack
  down               Stop the stack (keeps volumes and data)
  status             Show container status
  logs [service]     Follow logs (use --no-follow to print and exit)
  update             Pull the checkout, rebuild images and apply migrations
  mode <demo|local>  Switch the run mode and restart the stack
  doctor             Check Docker, GPU, models, ports and disk
  models [pull]      Download the local models (pull forces a refresh)
  test               Run the same suites as CI
  version            Print the CLI version
  help               Show this help

Options:
  --project-dir <path>   Checkout that holds .env and compose.yaml
  --profile <name>       Override the profile: cpu or gpu
  --dry-run              Print the docker compose command without running it
  -h, --help             Show this help
EOF
}

COMMAND=""
FOLLOW=1
SERVICE=""
POSITIONAL=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-dir) NR_PROJECT_DIR="${2:-}"; shift; nr_reinit_paths ;;
    --project-dir=*) NR_PROJECT_DIR="${1#*=}"; nr_reinit_paths ;;
    --profile) NEWSROOM_PROFILE="${2:-}"; shift ;;
    --profile=*) NEWSROOM_PROFILE="${1#*=}" ;;
    --dry-run) NR_DRY_RUN=1 ;;
    --no-follow) FOLLOW=0 ;;
    -h|--help) COMMAND=help ;;
    version|--version) COMMAND=version ;;
    up|down|status|logs|update|mode|doctor|models|test|help) COMMAND="$1" ;;
    -*) nr_die "unknown option: $1 (use --help)" ;;
    *) POSITIONAL+=("$1") ;;
  esac
  shift
done

if [ -z "$COMMAND" ]; then
  if [ "${#POSITIONAL[@]}" -gt 0 ]; then
    nr_die "unknown command: ${POSITIONAL[0]} (use --help)"
  fi
  usage
  exit 0
fi

MODE_VALUE=""
if [ "${#POSITIONAL[@]}" -gt 0 ]; then
  if [ "$COMMAND" = "logs" ]; then
    SERVICE="${POSITIONAL[0]}"
  elif [ "$COMMAND" = "models" ] && [ "${POSITIONAL[0]}" = "pull" ] && [ "${#POSITIONAL[@]}" -eq 1 ]; then
    :
  elif [ "$COMMAND" = "mode" ] && [ "${#POSITIONAL[@]}" -eq 1 ]; then
    MODE_VALUE="${POSITIONAL[0]}"
  else
    nr_die "unexpected argument: ${POSITIONAL[0]}"
  fi
fi

if [ -f "$NR_ENV_FILE" ]; then
  if [ -z "${NEWSROOM_PROFILE:-}" ]; then
    NEWSROOM_PROFILE="$(nr_env_get NEWSROOM_PROFILE)"
  fi
fi
NR_PROFILE="${NEWSROOM_PROFILE:-cpu}"
if [ "$NR_PROFILE" = "auto" ]; then
  NR_PROFILE=cpu
fi

require_env() {
  if [ ! -f "$NR_ENV_FILE" ]; then
    nr_die "no .env in $NR_PROJECT_DIR; run install.sh (or install.ps1) first"
  fi
}

require_compose_or_die() {
  [ -f "$NR_COMPOSE_FILE" ] || nr_die "compose file not found: $NR_COMPOSE_FILE"
}

require_repo_runner() {
  [ -f "$NR_REPO_ROOT/tools/run-all-tests.mjs" ] || nr_die "test runner not found: $NR_REPO_ROOT/tools/run-all-tests.mjs"
  nr_command_exists node || nr_die "node is required to run the test suite"
}

case "$COMMAND" in
  help)
    usage
    ;;
  version)
    printf 'newsroom %s\n' "${NEWSROOM_VERSION:-0.1.0}"
    ;;
  up)
    require_env
    require_compose_or_die
    nr_run_compose up -d --build
    nr_ok "stack is up (profile: $NR_PROFILE)"
    ;;
  down)
    require_env
    require_compose_or_die
    nr_run_compose down --remove-orphans
    nr_ok "stack is stopped"
    ;;
  status)
    require_env
    require_compose_or_die
    nr_compose ps
    ;;
  logs)
    require_env
    require_compose_or_die
    if [ "$FOLLOW" = "1" ] && [ -t 1 ]; then
      if [ -n "$SERVICE" ]; then
        nr_compose logs --tail=200 -f "$SERVICE"
      else
        nr_compose logs --tail=200 -f
      fi
    else
      if [ -n "$SERVICE" ]; then
        nr_compose logs --tail=200 "$SERVICE"
      else
        nr_compose logs --tail=200
      fi
    fi
    ;;
  models)
    require_env
    require_compose_or_die
    FORCE_MODELS=0
    [ "${POSITIONAL[0]:-}" = "pull" ] && FORCE_MODELS=1
    nr_download_models "$FORCE_MODELS"
    ;;
  mode)
    require_env
    require_compose_or_die
    case "$MODE_VALUE" in
      demo|local) ;;
      *) nr_die "usage: newsroom mode <demo|local>" ;;
    esac
    nr_env_set NEWSROOM_MODE "$MODE_VALUE"
    if [ "$MODE_VALUE" = "local" ]; then
      nr_env_set COMPOSE_PROFILES "local"
      nr_download_models
    else
      nr_env_set COMPOSE_PROFILES ""
      nr_info "demo mode needs no models"
    fi
    nr_info "restarting the stack in $MODE_VALUE mode"
    nr_run_compose down --remove-orphans
    nr_run_compose up -d --build
    nr_ok "run mode set to $MODE_VALUE"
    ;;
  test)
    require_repo_runner
    nr_info "running the same suites as CI (tools/run-all-tests.mjs)"
    ( cd "$NR_REPO_ROOT" && node tools/run-all-tests.mjs )
    nr_ok "test suite passed"
    ;;
  update)
    require_env
    require_compose_or_die
    if [ -n "$(git -C "$NR_REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
      nr_die "the checkout has uncommitted changes; commit or stash them before updating"
    fi
    if git -C "$NR_REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
      nr_run git -C "$NR_REPO_ROOT" pull --ff-only
    else
      nr_warn "no git remote configured; skipping git pull"
    fi
    nr_run_compose pull
    nr_run_compose build --pull
    nr_run_compose run --rm migrate
    nr_run_compose up -d
    nr_state_set MIGRATIONS_APPLIED 1
    nr_ok "update complete (profile: $NR_PROFILE)"
    ;;
  doctor)
    nr_print_header
    if nr_check_environment; then
      nr_ok "doctor: no blocking problems"
    else
      nr_fail "doctor: fix the failed checks above"
      exit 1
    fi
    printf '\nInstallation state (%s):\n' "$NR_STATE_FILE"
    if [ -f "$NR_STATE_FILE" ]; then
      sed 's/^/  /' "$NR_STATE_FILE"
    else
      printf '  not installed yet\n'
    fi
    if [ -f "$NR_ENV_FILE" ]; then
      run_mode="$(nr_env_get NEWSROOM_MODE)"
      if [ "$run_mode" = "demo" ]; then
        printf '\nModels: not required (demo mode)\n'
      else
        printf '\nModels: %s\n' "$( [ "$(nr_state_get MODELS_DOWNLOADED)" = "1" ] && echo downloaded || echo pending )"
      fi
      printf 'Admin:  %s\n' "$( [ "$(nr_state_get ADMIN_CREATED)" = "1" ] && echo initialized || echo pending )"
    fi
    ;;
  *)
    nr_die "unknown command: $COMMAND (use --help)"
    ;;
esac
