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

# --- Panel proxy network ---------------------------------------------------
#
# The API trusts X-Forwarded-For only from the panel's address on a dedicated
# Docker network. A hard-coded subnet collides with whatever the host already
# runs, so the installer picks a free /24, gives the panel a fixed address in
# it and writes both values (plus the matching trusted CIDR) to .env.

nr_ipv4_to_int() {
  local ip="$1" a b c d
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=$((10#${BASH_REMATCH[1]}))
  b=$((10#${BASH_REMATCH[2]}))
  c=$((10#${BASH_REMATCH[3]}))
  d=$((10#${BASH_REMATCH[4]}))
  if [ "$a" -gt 255 ] || [ "$b" -gt 255 ] || [ "$c" -gt 255 ] || [ "$d" -gt 255 ]; then
    return 1
  fi
  printf '%s' "$(( (a << 24) | (b << 16) | (c << 8) | d ))"
}

nr_cidr_overlaps() {
  local left="$1" right="$2" laddr lprefix raddr rprefix lint rint prefix mask
  [[ "$left" == */* && "$right" == */* ]] || return 1
  laddr="${left%/*}"
  lprefix="${left#*/}"
  raddr="${right%/*}"
  rprefix="${right#*/}"
  [[ "$lprefix" =~ ^[0-9]+$ && "$rprefix" =~ ^[0-9]+$ ]] || return 1
  lprefix=$((10#$lprefix))
  rprefix=$((10#$rprefix))
  if [ "$lprefix" -gt 32 ] || [ "$rprefix" -gt 32 ]; then
    return 1
  fi
  lint="$(nr_ipv4_to_int "$laddr")" || return 1
  rint="$(nr_ipv4_to_int "$raddr")" || return 1
  prefix=$((lprefix < rprefix ? lprefix : rprefix))
  if [ "$prefix" -eq 0 ]; then
    mask=0
  else
    mask=$(( (0xffffffff << (32 - prefix)) & 0xffffffff ))
  fi
  [ $((lint & mask)) -eq $((rint & mask)) ]
}

# Returns success when any Docker network other than this project's panel
# network already owns an overlapping range.
nr_panel_subnet_in_use() {
  local candidate="$1" name subnets subnet
  local exclude="${COMPOSE_PROJECT_NAME:-newsroom}_panelnet"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ "$name" = "$exclude" ] && continue
    subnets="$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$name" 2>/dev/null || true)"
    for subnet in $subnets; do
      if nr_cidr_overlaps "$candidate" "$subnet"; then
        return 0
      fi
    done
  done < <(docker network ls --format '{{.Name}}' 2>/dev/null || true)
  return 1
}

nr_ip_in_cidr() {
  local ip="$1" cidr="$2"
  nr_cidr_overlaps "${ip}/32" "$cidr"
}

nr_subnet_host_ip() {
  local cidr="$1" offset="${2:-10}" a b c d
  cidr="${cidr%/*}"
  IFS=. read -r a b c d <<<"$cidr"
  printf '%s' "${a}.${b}.${c}.$((10#$d + offset))"
}

nr_env_assign_panel_network() {
  local current_subnet current_ip subnet ip candidate
  local -a candidates=(
    172.28.240.0/24 172.29.240.0/24 172.30.240.0/24 172.31.240.0/24
    172.27.240.0/24 172.26.240.0/24 172.25.240.0/24 172.24.240.0/24
    10.253.240.0/24 10.252.240.0/24
  )
  current_subnet="$(nr_env_get NEWSROOM_PANEL_SUBNET)"
  current_ip="$(nr_env_get NEWSROOM_PANEL_IP)"
  subnet=""
  if [[ "$current_subnet" =~ ^[0-9.]+/24$ ]] && ! nr_panel_subnet_in_use "$current_subnet"; then
    subnet="$current_subnet"
  fi
  if [ -z "$subnet" ]; then
    for candidate in "${candidates[@]}"; do
      if ! nr_panel_subnet_in_use "$candidate"; then
        subnet="$candidate"
        break
      fi
    done
  fi
  [ -n "$subnet" ] || nr_die "could not find a free /24 for the panel proxy network"
  if [ -n "$current_ip" ] && nr_ip_in_cidr "$current_ip" "$subnet"; then
    ip="$current_ip"
  else
    ip="$(nr_subnet_host_ip "$subnet" 10)"
  fi
  nr_env_set NEWSROOM_PANEL_SUBNET "$subnet"
  nr_env_set NEWSROOM_PANEL_IP "$ip"
  nr_env_set TRUSTED_PROXY_CIDRS "$ip/32"
  nr_info "panel proxy network: $subnet (trusted proxy $ip)"
}

# Keeps the browser origin allow-lists in sync when --port changes the
# published panel port. Only the documented localhost defaults are rewritten.
nr_env_apply_panel_port() {
  local port="$1" key value updated
  [ -n "$port" ] || return 0
  for key in API_GATEWAY_ALLOWED_ORIGINS API_GATEWAY_TRUSTED_MUTATION_ORIGINS PANEL_PUBLIC_ORIGIN; do
    value="$(nr_env_get "$key")"
    [ -n "$value" ] || continue
    updated="${value//http:\/\/127.0.0.1:8080/http://127.0.0.1:${port}}"
    updated="${updated//http:\/\/localhost:8080/http://localhost:${port}}"
    if [ "$updated" != "$value" ]; then
      nr_env_set "$key" "$updated"
    fi
  done
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

