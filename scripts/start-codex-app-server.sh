#!/usr/bin/env bash
set -euo pipefail

load_dotenv() {
  local env_file="${1:-.env}"
  [[ -f "$env_file" ]] || return 0

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    case "$key" in
      CODEXCLAW_PORT|CODEXCLAW_DEPLOYMENT_MODE|CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE|CODEXCLAW_WORKSPACE_ROOT|CODEXCLAW_STATE_DIR|CODEXCLAW_CODEX_TOKEN_FILE|CODEXCLAW_CODEX_WS|CODEXCLAW_CODEX_LISTEN|CODEXCLAW_PLUGIN_SUPERVISION_ENABLED|CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME) ;;
      *) continue ;;
    esac
    [[ -z "${!key+x}" ]] || continue
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf -v "$key" '%s' "$value"
  done < "$env_file"
}

expand_home() {
  local value="$1"
  if [[ "$value" == "~" ]]; then
    printf '%s\n' "$HOME"
  elif [[ "$value" == "~/"* ]]; then
    printf '%s/%s\n' "$HOME" "${value#"~/"}"
  else
    printf '%s\n' "$value"
  fi
}

realpath_for_policy() {
  local path="$1"
  local current="$path"
  local suffix=""
  while [[ ! -e "$current" ]]; do
    local parent
    parent="$(dirname "$current")"
    [[ "$parent" == "$current" ]] && break
    suffix="/$(basename "$current")$suffix"
    current="$parent"
  done
  if [[ -e "$current" ]]; then
    if [[ -d "$current" ]]; then
      printf '%s%s\n' "$(cd "$current" && pwd -P)" "$suffix"
    else
      printf '%s/%s%s\n' "$(cd "$(dirname "$current")" && pwd -P)" "$(basename "$current")" "$suffix"
    fi
  else
    printf '%s\n' "$path"
  fi
}

is_inside_workspace() {
  local candidate
  candidate="$(realpath_for_policy "$1")"
  [[ "$candidate" == "$WORKSPACE_ROOT" || "$candidate" == "$WORKSPACE_ROOT/"* ]]
}

require_outside_workspace_or_local_dev() {
  local path="$1"
  local name="$2"
  if is_inside_workspace "$path"; then
    if [[ "$DEPLOYMENT_MODE" != "local_dev" || "$ALLOW_WORKSPACE_INTERNAL_STATE" != "true" ]]; then
      echo "$name must stay outside CODEXCLAW_WORKSPACE_ROOT unless local_dev workspace-internal state is explicitly enabled" >&2
      exit 1
    fi
  fi
}

validate_listen_url() {
  local url="$1"
  if [[ "$url" == *"@"* || "$url" == *"?"* || "$url" == *"#"* ]]; then
    echo "CODEXCLAW_CODEX_WS must not include credentials, query parameters, or fragments" >&2
    exit 1
  fi

  if [[ "$DEPLOYMENT_MODE" == "reverse_proxy_wss" ]]; then
    [[ "$url" =~ ^wss://[^/]+(/.*)?$ ]] && return 0
    echo "CODEXCLAW_CODEX_WS must use wss:// in reverse_proxy_wss mode" >&2
    exit 1
  fi

  if [[ "$DEPLOYMENT_MODE" == "local_loopback" ]]; then
    [[ "$url" =~ ^wss?://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/.*)?$ ]] && return 0
    echo "CODEXCLAW_CODEX_WS must point at a loopback host in local_loopback mode" >&2
    exit 1
  fi

  [[ "$url" =~ ^wss://[^/]+(/.*)?$ ]] && return 0
  [[ "$url" =~ ^ws://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/.*)?$ ]] && return 0
  echo "Refusing plaintext ws:// Codex app-server URL for a non-loopback host; use wss://" >&2
  exit 1
}

validate_app_server_listen_url() {
  local url="$1"
  if [[ "$url" == *"@"* || "$url" == *"?"* || "$url" == *"#"* ]]; then
    echo "CODEXCLAW_CODEX_LISTEN must not include credentials, query parameters, or fragments" >&2
    exit 1
  fi
  [[ "$url" =~ ^ws://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/.*)?$ ]] && return 0
  echo "CODEXCLAW_CODEX_LISTEN must be a loopback ws:// URL for the local app-server helper" >&2
  exit 1
}

scrub_codexclaw_env_for_app_server() {
  local key
  for key in "${!CODEXCLAW_@}"; do
    unset "$key"
  done
}

is_truthy() {
  case "$1" in
    1|true|TRUE|True|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

exec_app_server() {
  local -a env_args=()
  local key
  for key in PATH HOME TMPDIR TEMP TMP USER LOGNAME SHELL TERM LANG LC_ALL; do
    if [[ -n "${!key+x}" && -n "${!key}" ]]; then
      env_args+=("$key=${!key}")
    fi
  done
  if [[ -n "${MANAGED_CODEX_HOME:-}" ]]; then
    env_args+=("CODEX_HOME=$MANAGED_CODEX_HOME")
  elif [[ -n "${CODEX_HOME:-}" ]]; then
    env_args+=("CODEX_HOME=$CODEX_HOME")
  fi
  exec env -i "${env_args[@]}" codex app-server \
    --listen "$LISTEN_URL" \
    --ws-auth capability-token \
    --ws-token-file "$TOKEN_FILE"
}

load_dotenv ".env"

PORT="${CODEXCLAW_PORT:-4500}"
DEPLOYMENT_MODE="${CODEXCLAW_DEPLOYMENT_MODE:-local_loopback}"
ALLOW_WORKSPACE_INTERNAL_STATE="${CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE:-false}"
case "$DEPLOYMENT_MODE" in
  local_dev|local_loopback|reverse_proxy_wss) ;;
  *)
    echo "CODEXCLAW_DEPLOYMENT_MODE must be one of local_dev, local_loopback, reverse_proxy_wss" >&2
    exit 1
    ;;
esac
WORKSPACE_ROOT="$(expand_home "${CODEXCLAW_WORKSPACE_ROOT:-$(pwd)}")"
mkdir -p "$WORKSPACE_ROOT"
WORKSPACE_ROOT="$(cd "$WORKSPACE_ROOT" && pwd -P)"
STATE_DIR="$(expand_home "${CODEXCLAW_STATE_DIR:-$HOME/.codexclaw}")"
if [[ "$STATE_DIR" != /* ]]; then
  STATE_DIR="$WORKSPACE_ROOT/$STATE_DIR"
fi
if [[ -L "$STATE_DIR" ]]; then
  echo "Refusing symlink CODEXCLAW_STATE_DIR: $STATE_DIR" >&2
  exit 1
fi
require_outside_workspace_or_local_dev "$STATE_DIR" "CODEXCLAW_STATE_DIR"
mkdir -p "$STATE_DIR"
STATE_DIR="$(cd "$STATE_DIR" && pwd -P)"
require_outside_workspace_or_local_dev "$STATE_DIR" "CODEXCLAW_STATE_DIR"
chmod go-rwx "$STATE_DIR"
TOKEN_FILE="$(expand_home "${CODEXCLAW_CODEX_TOKEN_FILE:-$STATE_DIR/codex.token}")"
if [[ "$TOKEN_FILE" == ".codexclaw/codex.token" ]]; then
  TOKEN_FILE="$STATE_DIR/codex.token"
fi
if [[ "$TOKEN_FILE" != /* ]]; then
  TOKEN_FILE="$STATE_DIR/$TOKEN_FILE"
fi
CLIENT_URL="${CODEXCLAW_CODEX_WS:-ws://127.0.0.1:${PORT}}"
LISTEN_URL="${CODEXCLAW_CODEX_LISTEN:-ws://127.0.0.1:${PORT}}"
validate_listen_url "$CLIENT_URL"
validate_app_server_listen_url "$LISTEN_URL"

if [[ -L "$TOKEN_FILE" ]]; then
  echo "Refusing symlink token file: $TOKEN_FILE" >&2
  exit 1
fi
if [[ -e "$TOKEN_FILE" && ! -f "$TOKEN_FILE" ]]; then
  echo "Token path is not a regular file: $TOKEN_FILE" >&2
  exit 1
fi
require_outside_workspace_or_local_dev "$TOKEN_FILE" "CODEXCLAW_CODEX_TOKEN_FILE"
if [[ "$(realpath_for_policy "$TOKEN_FILE")" != "$STATE_DIR" && "$(realpath_for_policy "$TOKEN_FILE")" != "$STATE_DIR/"* ]]; then
  if [[ "$DEPLOYMENT_MODE" != "local_dev" || "$ALLOW_WORKSPACE_INTERNAL_STATE" != "true" ]]; then
    echo "CODEXCLAW_CODEX_TOKEN_FILE must stay inside CODEXCLAW_STATE_DIR unless local_dev workspace-internal state is explicitly enabled" >&2
    exit 1
  fi
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  if [[ "$DEPLOYMENT_MODE" == "reverse_proxy_wss" ]]; then
    echo "CODEXCLAW_CODEX_TOKEN_FILE must exist in reverse_proxy_wss mode: $TOKEN_FILE" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$TOKEN_FILE")"
  umask 077
  openssl rand -hex 32 > "$TOKEN_FILE"
  echo "Created token file: $TOKEN_FILE" >&2
fi

chmod go-rwx "$TOKEN_FILE"

TOKEN_FILE="$(cd "$(dirname "$TOKEN_FILE")" && pwd)/$(basename "$TOKEN_FILE")"

PLUGIN_SUPERVISION_ENABLED="${CODEXCLAW_PLUGIN_SUPERVISION_ENABLED:-false}"
if is_truthy "$PLUGIN_SUPERVISION_ENABLED"; then
  MANAGED_CODEX_HOME="$(expand_home "${CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME:-$STATE_DIR/codex-home}")"
  if [[ "$MANAGED_CODEX_HOME" != /* ]]; then
    MANAGED_CODEX_HOME="$STATE_DIR/$MANAGED_CODEX_HOME"
  fi
  if [[ -L "$MANAGED_CODEX_HOME" ]]; then
    echo "Refusing symlink CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME: $MANAGED_CODEX_HOME" >&2
    exit 1
  fi
  if [[ "$(realpath_for_policy "$MANAGED_CODEX_HOME")" != "$STATE_DIR" && "$(realpath_for_policy "$MANAGED_CODEX_HOME")" != "$STATE_DIR/"* ]]; then
    echo "CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME must stay inside CODEXCLAW_STATE_DIR" >&2
    exit 1
  fi
  mkdir -p "$MANAGED_CODEX_HOME"
  chmod go-rwx "$MANAGED_CODEX_HOME"
  MANAGED_CODEX_HOME="$(cd "$MANAGED_CODEX_HOME" && pwd -P)"
  if [[ -L "$MANAGED_CODEX_HOME/auth.json" ]]; then
    echo "Refusing symlink managed CODEX_HOME auth.json: $MANAGED_CODEX_HOME/auth.json" >&2
    exit 1
  fi
  if [[ ! -f "$MANAGED_CODEX_HOME/auth.json" ]]; then
    echo "CODEXCLAW_PLUGIN_SUPERVISION_ENABLED requires an authenticated managed CODEX_HOME. Run: CODEX_HOME=\"$MANAGED_CODEX_HOME\" codex login --device-auth" >&2
    exit 1
  fi
  chmod go-rwx "$MANAGED_CODEX_HOME/auth.json"
fi

cd "$WORKSPACE_ROOT"
scrub_codexclaw_env_for_app_server

exec_app_server
