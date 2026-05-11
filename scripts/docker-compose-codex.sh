#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

load_dotenv() {
  local env_file="$ROOT/.env"
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
      CODEXCLAW_WORKSPACE_ROOT|CODEXCLAW_STATE_DIR|CODEXCLAW_CODEX_TOKEN_FILE) ;;
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

resolve_from() {
  local base="$1"
  local input="$2"
  input="$(expand_home "$input")"
  if [[ "$input" = /* ]]; then
    printf '%s\n' "$input"
  else
    printf '%s/%s\n' "$base" "$input"
  fi
}

reject_parent_segments() {
  local name="$1"
  local value="$2"
  case "$value" in
    ..|../*|*/../*|*/..)
      echo "$name must not contain '..' path segments for container runs: $value" >&2
      exit 1
      ;;
  esac
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

is_inside() {
  local child
  local parent
  child="$(realpath_for_policy "$1")"
  parent="$(realpath_for_policy "$2")"
  [[ "$child" == "$parent" || "$child" == "$parent/"* ]]
}

load_dotenv

WORKSPACE_INPUT="${CODEXCLAW_WORKSPACE_ROOT:-$ROOT}"
STATE_INPUT="${CODEXCLAW_STATE_DIR:-$HOME/.codexclaw}"
TOKEN_INPUT="${CODEXCLAW_CODEX_TOKEN_FILE:-codex.token}"

reject_parent_segments "CODEXCLAW_WORKSPACE_ROOT" "$WORKSPACE_INPUT"
reject_parent_segments "CODEXCLAW_STATE_DIR" "$STATE_INPUT"
reject_parent_segments "CODEXCLAW_CODEX_TOKEN_FILE" "$TOKEN_INPUT"

WORKSPACE_ROOT="$(resolve_from "$ROOT" "$WORKSPACE_INPUT")"
mkdir -p "$WORKSPACE_ROOT"
WORKSPACE_ROOT="$(cd "$WORKSPACE_ROOT" && pwd -P)"

STATE_DIR="$(resolve_from "$WORKSPACE_ROOT" "$STATE_INPUT")"
if [[ -L "$STATE_DIR" ]]; then
  echo "Refusing symlink CODEXCLAW_STATE_DIR: $STATE_DIR" >&2
  exit 1
fi
if is_inside "$STATE_DIR" "$WORKSPACE_ROOT"; then
  echo "CODEXCLAW_STATE_DIR must stay outside CODEXCLAW_WORKSPACE_ROOT for container runs: $STATE_DIR" >&2
  exit 1
fi
mkdir -p "$STATE_DIR"
STATE_DIR="$(cd "$STATE_DIR" && pwd -P)"
chmod go-rwx "$STATE_DIR"

case "$TOKEN_INPUT" in
  .codexclaw/codex.token|.codexclaw\\codex.token)
    TOKEN_FILE="$STATE_DIR/codex.token"
    ;;
  *)
    TOKEN_FILE="$(resolve_from "$STATE_DIR" "$TOKEN_INPUT")"
    ;;
esac

if is_inside "$TOKEN_FILE" "$WORKSPACE_ROOT"; then
  echo "CODEXCLAW_CODEX_TOKEN_FILE must stay outside CODEXCLAW_WORKSPACE_ROOT for container runs: $TOKEN_FILE" >&2
  exit 1
fi
if ! is_inside "$TOKEN_FILE" "$STATE_DIR"; then
  echo "CODEXCLAW_CODEX_TOKEN_FILE must stay inside CODEXCLAW_STATE_DIR for container runs: $TOKEN_FILE" >&2
  exit 1
fi
if [[ -L "$TOKEN_FILE" ]]; then
  echo "Refusing symlink CODEXCLAW_CODEX_TOKEN_FILE: $TOKEN_FILE" >&2
  exit 1
fi
mkdir -p "$(dirname "$TOKEN_FILE")"
umask 077
if [[ ! -f "$TOKEN_FILE" ]]; then
  openssl rand -hex 32 > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
TOKEN_FILE="$(cd "$(dirname "$TOKEN_FILE")" && pwd -P)/$(basename "$TOKEN_FILE")"

export CODEXCLAW_WORKSPACE_ROOT="$WORKSPACE_ROOT"
export CODEXCLAW_STATE_DIR="$STATE_DIR"
export CODEXCLAW_CODEX_TOKEN_FILE="$TOKEN_FILE"

exec docker compose --project-directory "$ROOT" -f "$ROOT/compose.yaml" "$@"
