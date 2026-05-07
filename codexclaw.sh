#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
codexclaw installer

Usage:
  ./codexclaw.sh --dry-run [options]
  ./codexclaw.sh [options]

Options:
  --env-file PATH
  --workspace-root PATH
  --state-dir PATH
  --deployment-mode local_dev|local_loopback|reverse_proxy_wss
  --allow-workspace-internal-state true|false
  --codex-ws ws://127.0.0.1:4500
  --codex-listen ws://127.0.0.1:4500
  --token-file PATH
  --channel cli|telegram|discord|none
  --telegram-bot-token-file PATH
  --telegram-allowed-user-ids CSV
  --telegram-allow-all-users-for-local-dev true|false
  --discord-bot-token-file PATH
  --discord-application-id VALUE
  --discord-public-key-file PATH
  --discord-allowed-user-ids CSV
  --discord-allow-all-users-for-local-dev true|false
  --scheduler-enabled true|false
  --wiki-enabled true|false
  --yes
  --replace-secrets
  -h, --help
USAGE
}

fail() {
  printf 'codexclaw installer: %s\n' "$*" >&2
  exit 1
}

is_true() {
  case "${1:-false}" in
    true|TRUE|1|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

prompt() {
  local label="$1"
  local default_value="$2"
  local answer
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$label" "$default_value" >&2
  else
    printf '%s: ' "$label" >&2
  fi
  IFS= read -r answer
  printf '%s' "${answer:-$default_value}"
}

prompt_secret() {
  local label="$1"
  local answer
  printf '%s: ' "$label" >&2
  stty -echo 2>/dev/null || true
  IFS= read -r answer
  stty echo 2>/dev/null || true
  printf '\n' >&2
  printf '%s' "$answer"
}

confirm() {
  local label="$1"
  local answer
  printf '%s [y/N]: ' "$label" >&2
  IFS= read -r answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

abs_path() {
  local input="$1"
  local base="${2:-$PWD}"
  case "$input" in
    "~") input="${HOME:-$base}" ;;
    "~/"*) input="${HOME:-$base}/${input#~/}" ;;
    /*) ;;
    *) input="$base/$input" ;;
  esac

  local dir
  local file
  dir=$(dirname "$input")
  file=$(basename "$input")
  if [ -d "$dir" ]; then
    (cd "$dir" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$file")
    return
  fi

  local parent
  parent=$(abs_path "$dir" "/")
  printf '%s/%s\n' "$parent" "$file"
}

is_inside_dir() {
  local candidate
  local root
  candidate=$(abs_path "$1")
  root=$(abs_path "$2")
  case "$candidate" in
    "$root"|"$root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

url_scheme() {
  printf '%s' "$1" | sed -n 's,^\([^:]*\)://.*,\1,p'
}

url_host() {
  local rest="${1#*://}"
  rest="${rest%%/*}"
  rest="${rest%%\?*}"
  rest="${rest%%#*}"
  rest="${rest##*@}"
  if printf '%s' "$rest" | grep -q '^\['; then
    printf '%s' "$rest" | sed -n 's/^\[\([^]]*\)\].*/\1/p'
    return
  fi
  printf '%s' "${rest%%:*}"
}

is_loopback_host() {
  case "$1" in
    localhost|127.0.0.1|::1|'[::1]') return 0 ;;
    *) return 1 ;;
  esac
}

is_numeric_csv() {
  local value="$1"
  [ -n "$value" ] || return 1
  case "$value" in
    *[!0-9,[:space:]]*) return 1 ;;
    *[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

is_discord_public_key() {
  printf '%s' "$1" | grep -Eq '^[0-9a-fA-F]{64}$'
}

env_value() {
  local key="$1"
  local path="$2"
  [ -f "$path" ] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$path"
}

read_secret_file() {
  local path="$1"
  [ -n "$path" ] || return 0
  [ -f "$path" ] || fail "secret file does not exist: $path"
  head -n 1 "$path"
}

append_plan_line() {
  PLAN_LINES="${PLAN_LINES}${1}=${2}
"
}

plan_has_key() {
  printf '%s' "$PLAN_LINES" | awk -F= -v key="$1" '$1 == key { found=1 } END { exit found ? 0 : 1 }'
}

plan_value() {
  printf '%s' "$PLAN_LINES" | awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }'
}

is_secret_key() {
  case "$1" in
    CODEXCLAW_TELEGRAM_BOT_TOKEN|CODEXCLAW_DISCORD_BOT_TOKEN|CODEXCLAW_DISCORD_PUBLIC_KEY) return 0 ;;
    *) return 1 ;;
  esac
}

print_summary() {
  printf 'codexclaw installer summary\n'
  if is_true "$DRY_RUN"; then
    printf 'mode: dry-run\n'
  else
    printf 'mode: interactive\n'
  fi
  printf 'env file: %s\n' "$ENV_FILE"
  printf 'workspace: %s\n' "$WORKSPACE_ROOT"
  printf 'state dir: %s\n' "$STATE_DIR"
  printf 'deployment mode: %s\n' "$DEPLOYMENT_MODE"
  printf 'codex ws: %s\n' "$CODEX_WS"
  printf 'codex listen: %s\n' "$CODEX_LISTEN"
  printf 'channel: %s\n' "$CHANNEL"
  printf 'planned env:\n'
  printf '%s' "$PLAN_LINES" | while IFS='=' read -r key value; do
    [ -n "$key" ] || continue
    if is_secret_key "$key" && [ -n "$value" ]; then
      printf '  %s=[redacted]\n' "$key"
    else
      printf '  %s=%s\n' "$key" "$value"
    fi
  done
  printf 'next commands:\n'
  printf '  bun install\n'
  printf '  bun run start:codex\n'
  printf '  bun run cli\n'
}

validate_inputs() {
  case "$DEPLOYMENT_MODE" in
    local_dev|local_loopback|reverse_proxy_wss) ;;
    *) fail "deployment mode must be local_dev, local_loopback, or reverse_proxy_wss" ;;
  esac

  case "$CHANNEL" in
    cli|telegram|discord|none) ;;
    *) fail "channel must be cli, telegram, discord, or none" ;;
  esac

  local scheme host
  scheme=$(url_scheme "$CODEX_WS")
  host=$(url_host "$CODEX_WS")
  case "$CODEX_WS" in
    *://*@*) fail "CODEXCLAW_CODEX_WS must not include URL credentials" ;;
    *\?*) fail "CODEXCLAW_CODEX_WS must not include query parameters" ;;
    *\#*) fail "CODEXCLAW_CODEX_WS must not include fragments" ;;
  esac
  case "$scheme" in
    ws|wss) ;;
    *) fail "CODEXCLAW_CODEX_WS must use ws:// or wss://" ;;
  esac
  if [ "$DEPLOYMENT_MODE" = "reverse_proxy_wss" ] && [ "$scheme" != "wss" ]; then
    fail "CODEXCLAW_CODEX_WS must use wss:// in reverse_proxy_wss mode"
  fi
  if [ "$scheme" = "ws" ] && ! is_loopback_host "$host"; then
    fail "refusing plaintext ws:// Codex app-server URL for non-loopback host"
  fi
  if [ "$DEPLOYMENT_MODE" = "local_loopback" ] && ! is_loopback_host "$host"; then
    fail "CODEXCLAW_CODEX_WS must point at loopback in local_loopback mode"
  fi
  if [ "$DEPLOYMENT_MODE" = "local_dev" ] && ! is_loopback_host "$host"; then
    fail "CODEXCLAW_CODEX_WS must point at loopback in local_dev mode"
  fi
  local listen_scheme listen_host
  listen_scheme=$(url_scheme "$CODEX_LISTEN")
  listen_host=$(url_host "$CODEX_LISTEN")
  case "$CODEX_LISTEN" in
    *://*@*) fail "CODEXCLAW_CODEX_LISTEN must not include URL credentials" ;;
    *\?*) fail "CODEXCLAW_CODEX_LISTEN must not include query parameters" ;;
    *\#*) fail "CODEXCLAW_CODEX_LISTEN must not include fragments" ;;
  esac
  if [ "$listen_scheme" != "ws" ]; then
    fail "CODEXCLAW_CODEX_LISTEN must use ws://"
  fi
  if ! is_loopback_host "$listen_host" && [ "$DEPLOYMENT_MODE" != "local_dev" ]; then
    fail "CODEXCLAW_CODEX_LISTEN must point at loopback outside local_dev"
  fi

  local allow_state=false
  if [ "$DEPLOYMENT_MODE" = "local_dev" ] && is_true "$ALLOW_WORKSPACE_INTERNAL_STATE"; then
    allow_state=true
  fi
  if ! is_true "$allow_state" && is_inside_dir "$STATE_DIR" "$WORKSPACE_ROOT"; then
    fail "CODEXCLAW_STATE_DIR must stay outside CODEXCLAW_WORKSPACE_ROOT unless local_dev and workspace-internal state opt-in are both enabled"
  fi
  local token_abs
  token_abs=$(abs_path "$TOKEN_FILE" "$STATE_DIR")
  if ! is_true "$allow_state" && is_inside_dir "$token_abs" "$WORKSPACE_ROOT"; then
    fail "CODEXCLAW_CODEX_TOKEN_FILE must stay outside CODEXCLAW_WORKSPACE_ROOT unless local_dev and workspace-internal state opt-in are both enabled"
  fi
  if ! is_true "$allow_state" && ! is_inside_dir "$token_abs" "$STATE_DIR"; then
    fail "CODEXCLAW_CODEX_TOKEN_FILE must stay inside CODEXCLAW_STATE_DIR unless local_dev and workspace-internal state opt-in are both enabled"
  fi

  if [ "$CHANNEL" = "telegram" ]; then
    [ -n "$TELEGRAM_BOT_TOKEN" ] || fail "CODEXCLAW_TELEGRAM_BOT_TOKEN is required for Telegram"
    if is_true "$TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV" && [ "$DEPLOYMENT_MODE" != "local_dev" ]; then
      fail "CODEXCLAW_TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV=true requires local_dev deployment mode"
    fi
    if [ -z "$TELEGRAM_ALLOWED_USER_IDS" ] && ! { [ "$DEPLOYMENT_MODE" = "local_dev" ] && is_true "$TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV"; }; then
      fail "CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS is required unless local_dev and Telegram allow-all are explicitly enabled"
    fi
    if [ -n "$TELEGRAM_ALLOWED_USER_IDS" ] && ! is_numeric_csv "$TELEGRAM_ALLOWED_USER_IDS"; then
      fail "CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS must contain numeric Telegram user ids"
    fi
  fi

  if [ "$CHANNEL" = "discord" ]; then
    [ -n "$DISCORD_BOT_TOKEN" ] || fail "CODEXCLAW_DISCORD_BOT_TOKEN is required for Discord"
    [ -n "$DISCORD_APPLICATION_ID" ] || fail "CODEXCLAW_DISCORD_APPLICATION_ID is required for Discord"
    [ -n "$DISCORD_PUBLIC_KEY" ] || fail "CODEXCLAW_DISCORD_PUBLIC_KEY is required for Discord"
    is_numeric_csv "$DISCORD_APPLICATION_ID" || fail "CODEXCLAW_DISCORD_APPLICATION_ID must be a Discord snowflake"
    is_discord_public_key "$DISCORD_PUBLIC_KEY" || fail "CODEXCLAW_DISCORD_PUBLIC_KEY must be a 32-byte hex Ed25519 public key"
    if is_true "$DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV" && [ "$DEPLOYMENT_MODE" != "local_dev" ]; then
      fail "CODEXCLAW_DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV=true requires local_dev deployment mode"
    fi
    if [ -z "$DISCORD_ALLOWED_USER_IDS" ] && ! { [ "$DEPLOYMENT_MODE" = "local_dev" ] && is_true "$DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV"; }; then
      fail "CODEXCLAW_DISCORD_ALLOWED_USER_IDS is required unless local_dev and Discord allow-all are explicitly enabled"
    fi
    if [ -n "$DISCORD_ALLOWED_USER_IDS" ] && ! is_numeric_csv "$DISCORD_ALLOWED_USER_IDS"; then
      fail "CODEXCLAW_DISCORD_ALLOWED_USER_IDS must contain Discord snowflakes"
    fi
  fi
}

check_secret_overwrites() {
  [ -f "$ENV_FILE" ] || return 0
  local rows_count i row key value current
  rows_count=$(printf '%s' "$PLAN_LINES" | awk 'END { print NR }')
  i=1
  while [ "$i" -le "$rows_count" ]; do
    row=$(printf '%s' "$PLAN_LINES" | sed -n "${i}p")
    i=$((i + 1))
    [ -n "$row" ] || continue
    key="${row%%=*}"
    value="${row#*=}"
    [ -n "$key" ] || continue
    is_secret_key "$key" || continue
    [ -n "$value" ] || continue
    current=$(env_value "$key" "$ENV_FILE")
    [ -n "$current" ] || continue
    [ "$current" != "$value" ] || continue
    if is_true "$REPLACE_SECRETS"; then
      continue
    fi
    if is_true "$YES"; then
      fail "refusing to overwrite existing secret $key without --replace-secrets"
    fi
    if confirm "Replace existing secret $key?"; then
      continue
    fi
    fail "refusing to overwrite existing secret $key without confirmation"
  done
}

write_env() {
  local dir tmp written line key value
  dir=$(dirname "$ENV_FILE")
  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null || true
  umask 077
  tmp=$(mktemp "${ENV_FILE}.tmp.XXXXXX")
  chmod 600 "$tmp"
  if [ -f "$ENV_FILE" ]; then
    written=""
    : > "$tmp"
    while IFS= read -r line || [ -n "$line" ]; do
      key=""
      case "$line" in
        [A-Za-z_]*=*) key="${line%%=*}" ;;
      esac
      if [ -n "$key" ] && plan_has_key "$key"; then
        if ! printf '%s' "$written" | grep -Fxq "$key"; then
          value=$(plan_value "$key")
          printf '%s=%s\n' "$key" "$value" >> "$tmp"
          written="${written}${key}
"
        fi
      else
        printf '%s\n' "$line" >> "$tmp"
      fi
    done < "$ENV_FILE"
    printf '%s' "$PLAN_LINES" | while IFS='=' read -r key value; do
      [ -n "$key" ] || continue
      if ! printf '%s' "$written" | grep -Fxq "$key"; then
        printf '%s=%s\n' "$key" "$value" >> "$tmp"
      fi
    done
  else
    printf '%s' "$PLAN_LINES" > "$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

DRY_RUN=false
YES=false
REPLACE_SECRETS=false
ENV_FILE=".env"
WORKSPACE_ROOT=""
STATE_DIR=""
DEPLOYMENT_MODE=""
ALLOW_WORKSPACE_INTERNAL_STATE=""
CODEX_WS=""
CODEX_LISTEN=""
TOKEN_FILE=""
CHANNEL=""
TELEGRAM_BOT_TOKEN=""
TELEGRAM_BOT_TOKEN_FILE=""
TELEGRAM_ALLOWED_USER_IDS=""
TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV=""
DISCORD_BOT_TOKEN=""
DISCORD_BOT_TOKEN_FILE=""
DISCORD_APPLICATION_ID=""
DISCORD_PUBLIC_KEY=""
DISCORD_PUBLIC_KEY_FILE=""
DISCORD_ALLOWED_USER_IDS=""
DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV=""
SCHEDULER_ENABLED=""
WIKI_ENABLED=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --yes) YES=true ;;
    --replace-secrets) REPLACE_SECRETS=true ;;
    --env-file) shift; ENV_FILE="${1:-}" ;;
    --workspace-root) shift; WORKSPACE_ROOT="${1:-}" ;;
    --state-dir) shift; STATE_DIR="${1:-}" ;;
    --deployment-mode) shift; DEPLOYMENT_MODE="${1:-}" ;;
    --allow-workspace-internal-state) shift; ALLOW_WORKSPACE_INTERNAL_STATE="${1:-}" ;;
    --codex-ws) shift; CODEX_WS="${1:-}" ;;
    --codex-listen) shift; CODEX_LISTEN="${1:-}" ;;
    --token-file) shift; TOKEN_FILE="${1:-}" ;;
    --channel) shift; CHANNEL="${1:-}" ;;
    --telegram-bot-token-file) shift; TELEGRAM_BOT_TOKEN_FILE="${1:-}" ;;
    --telegram-allowed-user-ids) shift; TELEGRAM_ALLOWED_USER_IDS="${1:-}" ;;
    --telegram-allow-all-users-for-local-dev) shift; TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV="${1:-}" ;;
    --discord-bot-token-file) shift; DISCORD_BOT_TOKEN_FILE="${1:-}" ;;
    --discord-application-id) shift; DISCORD_APPLICATION_ID="${1:-}" ;;
    --discord-public-key-file) shift; DISCORD_PUBLIC_KEY_FILE="${1:-}" ;;
    --discord-allowed-user-ids) shift; DISCORD_ALLOWED_USER_IDS="${1:-}" ;;
    --discord-allow-all-users-for-local-dev) shift; DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV="${1:-}" ;;
    --scheduler-enabled) shift; SCHEDULER_ENABLED="${1:-}" ;;
    --wiki-enabled) shift; WIKI_ENABLED="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
  shift
done

[ -n "$ENV_FILE" ] || fail "--env-file requires a path"
ENV_FILE=$(abs_path "$ENV_FILE")
[ -z "$TELEGRAM_BOT_TOKEN_FILE" ] || TELEGRAM_BOT_TOKEN=$(read_secret_file "$(abs_path "$TELEGRAM_BOT_TOKEN_FILE")")
[ -z "$DISCORD_BOT_TOKEN_FILE" ] || DISCORD_BOT_TOKEN=$(read_secret_file "$(abs_path "$DISCORD_BOT_TOKEN_FILE")")
[ -z "$DISCORD_PUBLIC_KEY_FILE" ] || DISCORD_PUBLIC_KEY=$(read_secret_file "$(abs_path "$DISCORD_PUBLIC_KEY_FILE")")

INTERACTIVE_PROMPTS=false
if ! is_true "$DRY_RUN" && ! is_true "$YES" && [ -t 0 ]; then
  INTERACTIVE_PROMPTS=true
fi

if is_true "$INTERACTIVE_PROMPTS"; then
  [ -n "$WORKSPACE_ROOT" ] || WORKSPACE_ROOT=$(prompt "Workspace root" "$PWD")
  [ -n "$DEPLOYMENT_MODE" ] || DEPLOYMENT_MODE=$(prompt "Deployment mode" "local_loopback")
  [ -n "$STATE_DIR" ] || STATE_DIR=$(prompt "State dir" "${HOME:-$PWD}/.codexclaw")
  [ -n "$ALLOW_WORKSPACE_INTERNAL_STATE" ] || ALLOW_WORKSPACE_INTERNAL_STATE=$(prompt "Allow workspace-internal state" "false")
  [ -n "$CODEX_WS" ] || CODEX_WS=$(prompt "Codex app-server WebSocket URL" "ws://127.0.0.1:4500")
  [ -n "$CODEX_LISTEN" ] || CODEX_LISTEN=$(prompt "Codex app-server local listen URL" "$CODEX_WS")
  [ -n "$TOKEN_FILE" ] || TOKEN_FILE=$(prompt "Codex token file" "codex.token")
  [ -n "$CHANNEL" ] || CHANNEL=$(prompt "Channel" "cli")
fi

WORKSPACE_ROOT=$(abs_path "${WORKSPACE_ROOT:-$PWD}")
DEPLOYMENT_MODE="${DEPLOYMENT_MODE:-local_loopback}"
STATE_DIR=$(abs_path "${STATE_DIR:-${HOME:-$PWD}/.codexclaw}")
ALLOW_WORKSPACE_INTERNAL_STATE="${ALLOW_WORKSPACE_INTERNAL_STATE:-false}"
CODEX_WS="${CODEX_WS:-ws://127.0.0.1:4500}"
if [ -z "$CODEX_LISTEN" ]; then
  if [ "$DEPLOYMENT_MODE" = "local_loopback" ] && [ "$(url_scheme "$CODEX_WS")" = "ws" ]; then
    CODEX_LISTEN="$CODEX_WS"
  else
    CODEX_LISTEN="ws://127.0.0.1:4500"
  fi
fi
TOKEN_FILE="${TOKEN_FILE:-codex.token}"
CHANNEL="${CHANNEL:-cli}"

if is_true "$INTERACTIVE_PROMPTS"; then
  if [ "$CHANNEL" = "telegram" ]; then
    [ -n "$TELEGRAM_BOT_TOKEN" ] || TELEGRAM_BOT_TOKEN=$(prompt_secret "Telegram bot token")
    [ -n "$TELEGRAM_ALLOWED_USER_IDS" ] || TELEGRAM_ALLOWED_USER_IDS=$(prompt "Telegram allowed user IDs" "")
    [ -n "$TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV" ] || TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV=$(prompt "Telegram allow all users for local_dev" "false")
  fi
  if [ "$CHANNEL" = "discord" ]; then
    [ -n "$DISCORD_BOT_TOKEN" ] || DISCORD_BOT_TOKEN=$(prompt_secret "Discord bot token")
    [ -n "$DISCORD_APPLICATION_ID" ] || DISCORD_APPLICATION_ID=$(prompt "Discord application ID" "")
    [ -n "$DISCORD_PUBLIC_KEY" ] || DISCORD_PUBLIC_KEY=$(prompt_secret "Discord public key")
    [ -n "$DISCORD_ALLOWED_USER_IDS" ] || DISCORD_ALLOWED_USER_IDS=$(prompt "Discord allowed user IDs" "")
    [ -n "$DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV" ] || DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV=$(prompt "Discord allow all users for local_dev" "false")
  fi
  [ -n "$SCHEDULER_ENABLED" ] || SCHEDULER_ENABLED=$(prompt "Enable scheduler" "false")
  [ -n "$WIKI_ENABLED" ] || WIKI_ENABLED=$(prompt "Enable wiki" "false")
fi

TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV="${TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV:-false}"
DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV="${DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV:-false}"
SCHEDULER_ENABLED="${SCHEDULER_ENABLED:-false}"
WIKI_ENABLED="${WIKI_ENABLED:-false}"

validate_inputs

PLAN_LINES=""
append_plan_line "CODEXCLAW_DEPLOYMENT_MODE" "$DEPLOYMENT_MODE"
append_plan_line "CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE" "$ALLOW_WORKSPACE_INTERNAL_STATE"
append_plan_line "CODEXCLAW_CODEX_WS" "$CODEX_WS"
append_plan_line "CODEXCLAW_CODEX_LISTEN" "$CODEX_LISTEN"
append_plan_line "CODEXCLAW_WORKSPACE_ROOT" "$WORKSPACE_ROOT"
append_plan_line "CODEXCLAW_STATE_DIR" "$STATE_DIR"
append_plan_line "CODEXCLAW_CODEX_TOKEN_FILE" "$TOKEN_FILE"
append_plan_line "CODEXCLAW_DB" "codexclaw.sqlite"
append_plan_line "CODEXCLAW_SCHEDULER_ENABLED" "$SCHEDULER_ENABLED"
append_plan_line "CODEXCLAW_WIKI_ENABLED" "$WIKI_ENABLED"

if [ "$CHANNEL" = "telegram" ]; then
  append_plan_line "CODEXCLAW_TELEGRAM_BOT_TOKEN" "$TELEGRAM_BOT_TOKEN"
  append_plan_line "CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS" "$TELEGRAM_ALLOWED_USER_IDS"
  append_plan_line "CODEXCLAW_TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV" "$TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV"
fi

if [ "$CHANNEL" = "discord" ]; then
  append_plan_line "CODEXCLAW_DISCORD_BOT_TOKEN" "$DISCORD_BOT_TOKEN"
  append_plan_line "CODEXCLAW_DISCORD_APPLICATION_ID" "$DISCORD_APPLICATION_ID"
  append_plan_line "CODEXCLAW_DISCORD_PUBLIC_KEY" "$DISCORD_PUBLIC_KEY"
  append_plan_line "CODEXCLAW_DISCORD_ALLOWED_USER_IDS" "$DISCORD_ALLOWED_USER_IDS"
  append_plan_line "CODEXCLAW_DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV" "$DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV"
fi

print_summary

if is_true "$DRY_RUN"; then
  exit 0
fi

check_secret_overwrites
if ! is_true "$YES"; then
  confirm "Write $ENV_FILE with private permissions?" || fail "install cancelled"
fi
write_env
printf 'wrote %s\n' "$ENV_FILE"
