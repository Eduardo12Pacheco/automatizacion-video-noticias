#!/usr/bin/env bash
# Shared helpers for install.sh and bin/newsroom.sh.
#
# This file is sourced, never executed. It owns the filesystem layout, the
# Docker Compose invocation and the idempotent .env generation so the Linux
# entrypoints and the control CLI stay thin. The PowerShell implementation in
# infra/install/lib/common.ps1 mirrors the same behaviour.

set -o pipefail

NR_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
NR_PROJECT_DIR="${NEWSROOM_PROJECT_DIR:-$NR_REPO_ROOT}"
NR_ENV_FILE="${NEWSROOM_ENV_FILE:-$NR_PROJECT_DIR/.env}"
NR_ENV_TEMPLATE="${NEWSROOM_ENV_TEMPLATE:-$NR_PROJECT_DIR/.env.example}"
NR_COMPOSE_FILE="${NEWSROOM_COMPOSE_FILE:-$NR_PROJECT_DIR/compose.yaml}"
NR_STATE_DIR="$NR_PROJECT_DIR/.newsroom"
NR_STATE_FILE="$NR_STATE_DIR/state.env"
NR_PROFILE="${NEWSROOM_PROFILE:-auto}"
NR_DRY_RUN=0
NR_YES=0
NR_FORCE_PURGE="${NR_FORCE_PURGE:-0}"
NR_OPEN_PANEL=0
NR_DOWNLOAD_MODELS=1
NR_START_STACK=1
NR_BIN_DIR=""
NR_COMPOSE_MISSING_WARN=0
NR_ALLOW_MISSING_DOCKER="${NR_ALLOW_MISSING_DOCKER:-0}"
NR_CHECK_FAILURES=0
NR_CHECK_WARNINGS=0
NR_ADMIN_PASSWORD_PRINTED=""

# --- Logging ---------------------------------------------------------------

if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  NR_C_RESET=$'\033[0m'
  NR_C_DIM=$'\033[2m'
  NR_C_RED=$'\033[31m'
  NR_C_GREEN=$'\033[32m'
  NR_C_YELLOW=$'\033[33m'
  NR_C_BLUE=$'\033[34m'
else
  NR_C_RESET="" NR_C_DIM="" NR_C_RED="" NR_C_GREEN="" NR_C_YELLOW="" NR_C_BLUE=""
fi

nr_info() { printf '%s[nr]%s %s\n' "$NR_C_BLUE" "$NR_C_RESET" "$*"; }
nr_ok() { printf '%s[ok]%s %s\n' "$NR_C_GREEN" "$NR_C_RESET" "$*"; }
nr_warn() { printf '%s[warn]%s %s\n' "$NR_C_YELLOW" "$NR_C_RESET" "$*" >&2; NR_CHECK_WARNINGS=$((NR_CHECK_WARNINGS + 1)); }
nr_fail() { printf '%s[fail]%s %s\n' "$NR_C_RED" "$NR_C_RESET" "$*" >&2; }
nr_check_fail() { nr_fail "$*"; NR_CHECK_FAILURES=$((NR_CHECK_FAILURES + 1)); }
nr_die() { nr_fail "$*"; exit 1; }

nr_is_interactive() { [ -t 0 ] && [ -t 1 ] && [ "$NR_YES" = "0" ] && [ "${CI:-}" = "" ]; }

nr_can_use_tty() { [ -t 0 ]; }

nr_print_header() {
  nr_info "Newsroom local installer"
  nr_info "repository: $NR_REPO_ROOT"
  nr_info "project:    $NR_PROJECT_DIR"
}

# --- Small utilities -------------------------------------------------------

nr_command_exists() { command -v "$1" >/dev/null 2>&1; }

nr_quote() {
  local out=""
  local arg
  for arg in "$@"; do
    out+="$(printf '%q' "$arg") "
  done
  printf '%s' "${out% }"
}

nr_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

nr_generate_secret() {
  local bytes="${1:-24}"
  if nr_command_exists openssl; then
    openssl rand -hex "$bytes"
  elif [ -r /dev/urandom ]; then
    od -An -N"$bytes" -tx1 /dev/urandom | tr -d ' \n'
  else
    nr_die "no secure random source available (install openssl)"
  fi
}

nr_generate_password() {
  nr_generate_secret 12
}

nr_read_secret() {
  local prompt="$1" value=""
  if ! nr_can_use_tty; then
    nr_die "cannot prompt for a password without a terminal; set NEWSROOM_ADMIN_PASSWORD"
  fi
  read -r -s -p "$prompt" value
  printf '\n' >&2
  printf '%s' "$value"
}

# --- Resolved paths --------------------------------------------------------

# Recomputes every derived path after install.sh parses --project-dir/--env-file.
nr_reinit_paths() {
  NR_PROJECT_DIR="$(cd "$NR_PROJECT_DIR" && pwd)" || nr_die "project directory not found: $NR_PROJECT_DIR"
  NR_ENV_FILE="${NEWSROOM_ENV_FILE:-$NR_PROJECT_DIR/.env}"
  NR_ENV_TEMPLATE="${NEWSROOM_ENV_TEMPLATE:-$NR_PROJECT_DIR/.env.example}"
  NR_COMPOSE_FILE="${NEWSROOM_COMPOSE_FILE:-$NR_PROJECT_DIR/compose.yaml}"
  NR_STATE_DIR="$NR_PROJECT_DIR/.newsroom"
  NR_STATE_FILE="$NR_STATE_DIR/state.env"
}


nr_require_compose() {
  if [ ! -f "$NR_COMPOSE_FILE" ]; then
    if [ "$NR_COMPOSE_MISSING_WARN" = "1" ]; then
      nr_warn "compose file not found: $NR_COMPOSE_FILE (the T8 stack provides it)"
      return 1
    fi
    nr_die "compose file not found: $NR_COMPOSE_FILE (install the full stack or set NEWSROOM_COMPOSE_FILE)"
  fi
  return 0
}

# --- Docker and Compose ----------------------------------------------------

nr_docker_cli_ok() {
  nr_command_exists docker || return 1
  docker --version >/dev/null 2>&1
}

nr_docker_daemon_ok() {
  docker info >/dev/null 2>&1
}

nr_compose_cli_ok() {
  docker compose version >/dev/null 2>&1
}

nr_compose() {
  local args=(compose)
  if [ -f "$NR_ENV_FILE" ]; then
    args+=(--env-file "$NR_ENV_FILE")
  fi
  args+=(-f "$NR_COMPOSE_FILE")
  if [ -n "$NR_PROFILE" ] && [ "$NR_PROFILE" != "auto" ]; then
    args+=(--profile "$NR_PROFILE")
  fi
  ( cd "$NR_PROJECT_DIR" && docker "${args[@]}" "$@" )
}

nr_run() {
  if [ "$1" = "nr_compose" ]; then
    local shown=(docker compose)
    [ -f "$NR_ENV_FILE" ] && shown+=(--env-file "$NR_ENV_FILE")
    shown+=(-f "$NR_COMPOSE_FILE" --profile "$NR_PROFILE")
    nr_info "run: $(nr_quote "${shown[@]}" "${@:2}")"
  else
    nr_info "run: $(nr_quote "$@")"
  fi
  if [ "$NR_DRY_RUN" = "1" ]; then
    return 0
  fi
  "$@"
}

nr_run_compose() {
  nr_run nr_compose "$@"
}

# Runs a command with a secret on stdin so it never appears in argv.
nr_run_compose_with_stdin() {
  local input="$1"
  shift
  nr_info "run: $(nr_quote "$@") (password on stdin)"
  if [ "$NR_DRY_RUN" = "1" ]; then
    return 0
  fi
  printf '%s' "$input" | nr_compose "$@"
}

# The library is split by concern; common.sh is the single entrypoint so the
# installer and the control CLI only have to source one file.
NR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/install/lib/env.sh
. "$NR_LIB_DIR/env.sh"
# shellcheck source=infra/install/lib/host.sh
. "$NR_LIB_DIR/host.sh"
# shellcheck source=infra/install/lib/steps.sh
. "$NR_LIB_DIR/steps.sh"
