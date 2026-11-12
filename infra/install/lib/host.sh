#!/usr/bin/env bash
# Part of the Newsroom installer library; sourced by common.sh, never executed.

# --- Hardware and host checks ---------------------------------------------

nr_free_disk_mb() {
  # Explicit override for filesystems where df reports the wrong volume (and
  # for hermetic installer tests). Documented in docs/INSTALL.md.
  if [ -n "${NEWSROOM_DISK_MB_OVERRIDE:-}" ]; then
    case "$NEWSROOM_DISK_MB_OVERRIDE" in
      ''|*[!0-9]*) nr_warn "ignoring NEWSROOM_DISK_MB_OVERRIDE (expected a number of megabytes)" ;;
      *) printf '%s' "$NEWSROOM_DISK_MB_OVERRIDE"; return 0 ;;
    esac
  fi
  local path="${1:-$NR_PROJECT_DIR}"
  df -Pm "$path" 2>/dev/null | awk 'NR==2 {print $4}'
}

nr_run_mode_value() {
  local mode="${NR_RUN_MODE:-}"
  if [ -z "$mode" ]; then
    mode="$(nr_env_get NEWSROOM_MODE)"
  fi
  printf '%s' "${mode:-demo}"
}

nr_required_disk_mb() {
  if [ "$(nr_run_mode_value)" = "local" ]; then
    printf '10240'
  else
    printf '2048'
  fi
}

nr_ram_mb() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemTotal:/ {printf "%d", $2 / 1024}' /proc/meminfo
  elif nr_command_exists sysctl; then
    sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d", $1 / 1048576}'
  else
    printf '0'
  fi
}

nr_gpu_present() {
  nr_command_exists nvidia-smi || return 1
  nvidia-smi -L 2>/dev/null | grep -qi 'GPU'
}

nr_gpu_container_ready() {
  if [ "$(uname -s 2>/dev/null)" != "Linux" ]; then
    # Docker Desktop provides the WSL2 GPU path on Windows and macOS.
    return 0
  fi
  nr_command_exists nvidia-ctk && return 0
  nr_command_exists nvidia-container-toolkit && return 0
  docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -qi nvidia
}

# Proves that the NVIDIA runtime can actually hand the device to a container,
# not merely that the toolkit is installed. Uses the same documented CUDA probe
# image as the T30 acceptance check; override the image in air-gapped setups.
nr_gpu_passthrough() {
  nr_gpu_overlay_is_required || return 1
  local image="${NEWSROOM_GPU_PROBE_IMAGE:-nvidia/cuda:12.4.1-base-ubuntu22.04}"
  local timeout_sec="${NEWSROOM_GPU_PROBE_TIMEOUT_SECONDS:-120}"
  local cmd=(docker run --rm --gpus all "$image" nvidia-smi -L)
  if nr_command_exists timeout; then
    timeout "$timeout_sec" "${cmd[@]}"
  else
    "${cmd[@]}"
  fi
}

nr_port_in_use() {
  local port="$1"
  if [ -n "${NEWSROOM_LISTENING_PORTS_OVERRIDE:-}" ]; then
    case ",${NEWSROOM_LISTENING_PORTS_OVERRIDE}," in
      *",${port},"*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  if nr_command_exists ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}$"
  elif nr_command_exists lsof; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

# True when the current project's Compose stack publishes this host port. The
# doctor must not warn about the stack it is checking.
nr_stack_publishes_port() {
  local port="$1" published=""
  [ -f "$NR_ENV_FILE" ] || return 1
  nr_command_exists docker || return 1
  published="$(nr_compose ps --format json 2>/dev/null || true)"
  [ -n "$published" ] || return 1
  printf '%s' "$published" | grep -qE "\"PublishedPort\"[[:space:]]*:[[:space:]]*${port}([^0-9]|$)"
}

nr_resolve_profile() {
  local requested="${1:-auto}"
  case "$requested" in
    cpu) NR_PROFILE=cpu ;;
    gpu) NR_PROFILE=gpu ;;
    auto)
      if nr_gpu_present; then
        if nr_gpu_container_ready; then
          NR_PROFILE=gpu
          nr_ok "NVIDIA GPU detected, using the gpu profile"
        else
          NR_PROFILE=cpu
          nr_warn "NVIDIA GPU detected but the container toolkit is missing; using the cpu profile"
          nr_warn "install nvidia-container-toolkit to enable the gpu profile"
        fi
      else
        NR_PROFILE=cpu
        nr_ok "no NVIDIA GPU detected, using the cpu profile"
      fi
      ;;
    *) nr_die "unknown profile: $requested (expected auto, cpu or gpu)" ;;
  esac
}

# S11: guided install. Both prompts are skipped with --yes, a non-interactive
# terminal or CI, and when the matching explicit flag/environment is present.
nr_prompt_mode() {
  local answer=""
  nr_info "Choose the run mode:"
  nr_info "  demo  - instant, deterministic stubs, no model download (default)"
  nr_info "  local - real Ollama, Whisper and Piper models on this machine"
  while :; do
    printf 'Run mode [demo/local] (demo): ' >&2
    IFS= read -r answer || answer=""
    answer="${answer:-demo}"
    case "$answer" in
      demo|local) NR_RUN_MODE="$answer"; return 0 ;;
      *) nr_warn "please answer demo or local" ;;
    esac
  done
}

nr_prompt_profile() {
  local answer=""
  if ! nr_gpu_present; then
    return 0
  fi
  if ! nr_gpu_container_ready; then
    return 0
  fi
  nr_info "NVIDIA GPU detected and the container runtime is ready."
  while :; do
    printf 'Use the GPU profile? [Y/n]: ' >&2
    IFS= read -r answer || answer=""
    case "${answer:-y}" in
      y|Y|yes|YES|Yes) NR_PROFILE=gpu; return 0 ;;
      n|N|no|NO|No) NR_PROFILE=cpu; return 0 ;;
      *) nr_warn "please answer yes or no" ;;
    esac
  done
}

# --- Checks ----------------------------------------------------------------

nr_check_environment() {
  local disk_mb ram_mb port
  nr_info "checking host prerequisites"

  if nr_docker_cli_ok; then
    nr_ok "docker: $(docker --version 2>/dev/null | head -n 1)"
  elif [ "$NR_ALLOW_MISSING_DOCKER" = "1" ]; then
    nr_warn "docker is not installed; skipping the Docker-dependent checks"
  else
    nr_check_fail "docker is not installed or not in PATH"
  fi

  if nr_docker_cli_ok && nr_compose_cli_ok; then
    nr_ok "docker compose: $(docker compose version --short 2>/dev/null | head -n 1)"
  elif [ "$NR_ALLOW_MISSING_DOCKER" != "1" ]; then
    nr_check_fail "docker compose v2 plugin is not available"
  fi

  if nr_docker_cli_ok && nr_docker_daemon_ok; then
    nr_ok "docker daemon is reachable"
  elif [ "$NR_ALLOW_MISSING_DOCKER" != "1" ]; then
    nr_check_fail "docker daemon is not reachable (start Docker Desktop or the docker service)"
  fi

  local required_disk_mb mode_label
  required_disk_mb="$(nr_required_disk_mb)"
  mode_label="$(nr_run_mode_value)"
  disk_mb="$(nr_free_disk_mb)"
  if [ -n "$disk_mb" ] && [ "$disk_mb" -ge "$required_disk_mb" ]; then
    nr_ok "free disk: ${disk_mb} MB (${mode_label} mode needs ${required_disk_mb} MB)"
  elif [ -n "$disk_mb" ]; then
    nr_check_fail "only ${disk_mb} MB free; ${mode_label} mode needs at least ${required_disk_mb} MB for images and models"
  else
    nr_warn "could not determine free disk space"
  fi

  ram_mb="$(nr_ram_mb)"
  if [ -n "$ram_mb" ] && [ "$ram_mb" -ge 8192 ]; then
    nr_ok "RAM: ${ram_mb} MB"
  elif [ -n "$ram_mb" ] && [ "$ram_mb" -gt 0 ]; then
    nr_warn "only ${ram_mb} MB RAM; 8192 MB is recommended for the full stack"
  else
    nr_warn "could not determine installed RAM"
  fi

  if nr_gpu_present; then
    nr_ok "NVIDIA GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1)"
    if nr_gpu_container_ready; then
      nr_ok "NVIDIA container runtime is available"
    else
      nr_warn "NVIDIA container toolkit is missing; the gpu profile will not start"
    fi
  elif nr_gpu_overlay_is_required; then
    nr_check_fail "GPU passthrough: the gpu profile is selected but nvidia-smi is not available"
  else
    nr_info "NVIDIA GPU: not detected (cpu profile)"
  fi

  if nr_gpu_overlay_is_required; then
    if nr_docker_daemon_ok && nr_gpu_passthrough >/dev/null 2>&1; then
      nr_ok "GPU passthrough: nvidia-smi runs inside a container"
    elif [ "$NR_ALLOW_MISSING_DOCKER" != "1" ]; then
      nr_check_fail "GPU passthrough failed: install nvidia-container-toolkit and run 'docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi'"
    fi
  elif nr_gpu_present; then
    nr_info "GPU passthrough: not checked (cpu profile; use --profile gpu)"
  fi

  local configured_ports=()
  configured_ports+=("${NR_PORT_OVERRIDE:-$(nr_env_get PANEL_PORT)}")
  configured_ports+=("$(nr_env_get API_GATEWAY_PORT)")
  configured_ports+=("$(nr_env_get POSTGRES_PORT)")
  configured_ports+=("$(nr_env_get SEARXNG_PORT)")
  local defaults=(8080 8099 5432 8888)
  local index
  for index in 0 1 2 3; do
    port="${configured_ports[$index]:-${defaults[$index]}}"
    if nr_port_in_use "$port"; then
      if nr_stack_publishes_port "$port"; then
        nr_ok "port ${port} is published by this Compose stack"
      else
        nr_warn "port ${port} is already in use; change it in .env if the stack fails to start"
      fi
    else
      nr_ok "port ${port} is free"
    fi
  done

  if [ -f "$NR_COMPOSE_FILE" ]; then
    nr_ok "compose file: $NR_COMPOSE_FILE"
  else
    nr_warn "compose file is not available yet"
  fi

  if [ -f "$NR_ENV_FILE" ]; then
    nr_ok "environment file: $NR_ENV_FILE"
  else
    nr_info "environment file will be created from .env.example"
  fi

  if [ "$NR_CHECK_FAILURES" -gt 0 ]; then
    nr_fail "${NR_CHECK_FAILURES} prerequisite check(s) failed"
    return 1
  fi
  nr_ok "prerequisites OK (${NR_CHECK_WARNINGS} warning(s))"
  return 0
}

