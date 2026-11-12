#!/usr/bin/env bash
# Part of the Newsroom installer library; sourced by common.sh, never executed.

# --- .env generation -------------------------------------------------------

# shellcheck disable=SC2034
declare -gA NR_ENV_VALUES=()

nr_env_parse_file() {
  local file="$1"
  local line key value
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|'#'*) continue ;;
      export\ *) line="${line#export }" ;;
    esac
    case "$line" in
      *=*) key="${line%%=*}"; value="${line#*=}" ;;
      *) continue ;;
    esac
    if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      NR_ENV_VALUES["$key"]="$value"
    fi
  done < "$file"
}

nr_env_expand_tokens() {
  local value="$1" key
  for key in "${!NR_ENV_VALUES[@]}"; do
    if [[ "$value" == *"__GENERATE_${key}__"* ]]; then
      value="${value//__GENERATE_${key}__/${NR_ENV_VALUES[$key]}}"
    fi
  done
  if [[ "$value" == *"__GENERATE__"* ]]; then
    value="${value//__GENERATE__/$(nr_generate_secret 24)}"
  fi
  printf '%s' "$value"
}

# Creates .env from the template or fills missing values in an existing .env.
# Existing values (including user-edited secrets) are never overwritten.
nr_env_ensure() {
  local template="$NR_ENV_TEMPLATE" target="$NR_ENV_FILE"
  [ -f "$template" ] || nr_die "environment template not found: $template"

  NR_ENV_VALUES=()
  nr_env_parse_file "$target"

  local line key value
  declare -A template_keys=()
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) key="${line%%=*}"; value="${line#*=}" ;; *) continue ;; esac
    template_keys["$key"]=1
    if [ -z "${NR_ENV_VALUES[$key]+x}" ]; then
      if [ "$value" = "__GENERATE__" ]; then
        NR_ENV_VALUES["$key"]="$(nr_generate_secret 24)"
      else
        NR_ENV_VALUES["$key"]="$value"
      fi
    fi
  done < "$template"

  # Resolve cross-key tokens such as DATABASE_URL's password reference.
  for key in "${!NR_ENV_VALUES[@]}"; do
    NR_ENV_VALUES["$key"]="$(nr_env_expand_tokens "${NR_ENV_VALUES[$key]}")"
  done

  local tmp
  tmp="$(mktemp "${target}.tmp.XXXXXX")"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|'#'*) printf '%s\n' "$line" ;;
      export\ *) printf '%s\n' "$line" ;;
      *=*)
        key="${line%%=*}"
        printf '%s=%s\n' "$key" "${NR_ENV_VALUES[$key]}"
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$template" > "$tmp"

  # Preserve keys that only exist in the operator's current .env.
  for key in "${!NR_ENV_VALUES[@]}"; do
    if [ -z "${template_keys[$key]+x}" ]; then
      printf '%s=%s\n' "$key" "${NR_ENV_VALUES[$key]}" >> "$tmp"
    fi
  done

  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$target"
  chmod 600 "$target" 2>/dev/null || true
  nr_ok "environment file ready: $target"
}

nr_env_get() {
  local key="$1"
  [ -f "$NR_ENV_FILE" ] || return 0
  awk -v key="$key" '
    $0 !~ /^[[:space:]]*#/ {
      split($0, parts, "=");
      if (parts[1] == key) { sub(/^[^=]*=/, "", $0); print $0; exit }
    }
  ' "$NR_ENV_FILE"
}

nr_env_set() {
  local key="$1" value="$2"
  [ -f "$NR_ENV_FILE" ] || return 0
  local tmp
  tmp="$(mktemp "${NR_ENV_FILE}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ ("^" key "=") { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$NR_ENV_FILE" > "$tmp"
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$NR_ENV_FILE"
}

# --- Installation state ----------------------------------------------------

nr_state_get() {
  local key="$1"
  [ -f "$NR_STATE_FILE" ] || return 0
  awk -v key="$key" '
    $0 !~ /^[[:space:]]*#/ {
      split($0, parts, "=");
      if (parts[1] == key) { sub(/^[^=]*=/, "", $0); print $0; exit }
    }
  ' "$NR_STATE_FILE"
}

nr_state_set() {
  local key="$1" value="$2"
  [ "$NR_DRY_RUN" = "1" ] && return 0
  mkdir -p "$NR_STATE_DIR"
  touch "$NR_STATE_FILE"
  chmod 600 "$NR_STATE_FILE" 2>/dev/null || true
  local tmp
  tmp="$(mktemp "${NR_STATE_FILE}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ ("^" key "=") { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$NR_STATE_FILE" > "$tmp"
  mv "$tmp" "$NR_STATE_FILE"
}

