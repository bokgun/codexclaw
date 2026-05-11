#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
IMAGE="${CODEXCLAW_APPLE_CONTAINER_IMAGE:-codexclaw/codex-app-server:0.128.0}"
CONTAINER_NAME="${CODEXCLAW_APPLE_CONTAINER_NAME:-codexclaw-codex-app-server}"
AUTH_VOLUME="${CODEXCLAW_APPLE_CONTAINER_AUTH_VOLUME:-codexclaw-codex-app-server-home}"
RUNTIME_TOKEN="/run/secrets/codex.token"
RUNTIME_SECRET_DIR="/run/secrets"

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

prepare_paths() {
  load_dotenv

  local workspace_input="${CODEXCLAW_WORKSPACE_ROOT:-$ROOT}"
  local state_input="${CODEXCLAW_STATE_DIR:-$HOME/.codexclaw}"
  local token_input="${CODEXCLAW_CODEX_TOKEN_FILE:-codex.token}"

  reject_parent_segments "CODEXCLAW_WORKSPACE_ROOT" "$workspace_input"
  reject_parent_segments "CODEXCLAW_STATE_DIR" "$state_input"
  reject_parent_segments "CODEXCLAW_CODEX_TOKEN_FILE" "$token_input"

  CODEXCLAW_APPLE_WORKSPACE_ROOT="$(resolve_from "$ROOT" "$workspace_input")"
  mkdir -p "$CODEXCLAW_APPLE_WORKSPACE_ROOT"
  CODEXCLAW_APPLE_WORKSPACE_ROOT="$(cd "$CODEXCLAW_APPLE_WORKSPACE_ROOT" && pwd -P)"

  CODEXCLAW_APPLE_STATE_DIR="$(resolve_from "$CODEXCLAW_APPLE_WORKSPACE_ROOT" "$state_input")"
  if [[ -L "$CODEXCLAW_APPLE_STATE_DIR" ]]; then
    echo "Refusing symlink CODEXCLAW_STATE_DIR: $CODEXCLAW_APPLE_STATE_DIR" >&2
    exit 1
  fi
  if is_inside "$CODEXCLAW_APPLE_STATE_DIR" "$CODEXCLAW_APPLE_WORKSPACE_ROOT"; then
    echo "CODEXCLAW_STATE_DIR must stay outside CODEXCLAW_WORKSPACE_ROOT for container runs: $CODEXCLAW_APPLE_STATE_DIR" >&2
    exit 1
  fi
  mkdir -p "$CODEXCLAW_APPLE_STATE_DIR"
  CODEXCLAW_APPLE_STATE_DIR="$(cd "$CODEXCLAW_APPLE_STATE_DIR" && pwd -P)"
  chmod go-rwx "$CODEXCLAW_APPLE_STATE_DIR"

  case "$token_input" in
    .codexclaw/codex.token|.codexclaw\\codex.token)
      CODEXCLAW_APPLE_TOKEN_FILE="$CODEXCLAW_APPLE_STATE_DIR/codex.token"
      ;;
    *)
      CODEXCLAW_APPLE_TOKEN_FILE="$(resolve_from "$CODEXCLAW_APPLE_STATE_DIR" "$token_input")"
      ;;
  esac

  if is_inside "$CODEXCLAW_APPLE_TOKEN_FILE" "$CODEXCLAW_APPLE_WORKSPACE_ROOT"; then
    echo "CODEXCLAW_CODEX_TOKEN_FILE must stay outside CODEXCLAW_WORKSPACE_ROOT for container runs: $CODEXCLAW_APPLE_TOKEN_FILE" >&2
    exit 1
  fi
  if ! is_inside "$CODEXCLAW_APPLE_TOKEN_FILE" "$CODEXCLAW_APPLE_STATE_DIR"; then
    echo "CODEXCLAW_CODEX_TOKEN_FILE must stay inside CODEXCLAW_STATE_DIR for container runs: $CODEXCLAW_APPLE_TOKEN_FILE" >&2
    exit 1
  fi
  if [[ -L "$CODEXCLAW_APPLE_TOKEN_FILE" ]]; then
    echo "Refusing symlink CODEXCLAW_CODEX_TOKEN_FILE: $CODEXCLAW_APPLE_TOKEN_FILE" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$CODEXCLAW_APPLE_TOKEN_FILE")"
  umask 077
  if [[ ! -f "$CODEXCLAW_APPLE_TOKEN_FILE" ]]; then
    openssl rand -hex 32 > "$CODEXCLAW_APPLE_TOKEN_FILE"
  fi
  chmod 600 "$CODEXCLAW_APPLE_TOKEN_FILE"
  CODEXCLAW_APPLE_TOKEN_FILE="$(cd "$(dirname "$CODEXCLAW_APPLE_TOKEN_FILE")" && pwd -P)/$(basename "$CODEXCLAW_APPLE_TOKEN_FILE")"

  CODEXCLAW_APPLE_TOKEN_MOUNT_DIR="$CODEXCLAW_APPLE_STATE_DIR/apple-container-token"
  if [[ -L "$CODEXCLAW_APPLE_TOKEN_MOUNT_DIR" ]]; then
    echo "Refusing symlink Apple Container token mount dir: $CODEXCLAW_APPLE_TOKEN_MOUNT_DIR" >&2
    exit 1
  fi
  mkdir -p "$CODEXCLAW_APPLE_TOKEN_MOUNT_DIR"
  chmod 700 "$CODEXCLAW_APPLE_TOKEN_MOUNT_DIR"
  if [[ -e "$CODEXCLAW_APPLE_TOKEN_MOUNT_DIR/codex.token" ]]; then
    chmod u+w "$CODEXCLAW_APPLE_TOKEN_MOUNT_DIR/codex.token"
  fi
  cp "$CODEXCLAW_APPLE_TOKEN_FILE" "$CODEXCLAW_APPLE_TOKEN_MOUNT_DIR/codex.token"
  chmod 400 "$CODEXCLAW_APPLE_TOKEN_MOUNT_DIR/codex.token"
  CODEXCLAW_APPLE_TOKEN_MOUNT_DIR="$(cd "$CODEXCLAW_APPLE_TOKEN_MOUNT_DIR" && pwd -P)"
}

ensure_auth_volume() {
  if ! container volume inspect "$AUTH_VOLUME" >/dev/null 2>&1; then
    container volume create "$AUTH_VOLUME" >/dev/null
  fi
}

set_base_run_args() {
  BASE_RUN_ARGS=(
    --init
    --mount "type=bind,source=$CODEXCLAW_APPLE_TOKEN_MOUNT_DIR,target=$RUNTIME_SECRET_DIR,readonly"
    --mount "type=bind,source=$CODEXCLAW_APPLE_WORKSPACE_ROOT,target=$CODEXCLAW_APPLE_WORKSPACE_ROOT"
    --mount "type=volume,source=$AUTH_VOLUME,target=/home/codex/.codex"
    --workdir "$CODEXCLAW_APPLE_WORKSPACE_ROOT"
  )
}

usage() {
  cat <<'EOF'
Usage:
  scripts/apple-container-codex.sh build [container build args...]
  scripts/apple-container-codex.sh login [codex login args...]
  scripts/apple-container-codex.sh run [command...]
  scripts/apple-container-codex.sh up
  scripts/apple-container-codex.sh down
  scripts/apple-container-codex.sh ps
  scripts/apple-container-codex.sh logs
  scripts/apple-container-codex.sh inspect

Environment:
  CODEXCLAW_APPLE_CONTAINER_IMAGE        default codexclaw/codex-app-server:0.128.0
  CODEXCLAW_APPLE_CONTAINER_NAME         default codexclaw-codex-app-server
  CODEXCLAW_APPLE_CONTAINER_AUTH_VOLUME  default codexclaw-codex-app-server-home
EOF
}

cmd="${1:-}"
[[ -n "$cmd" ]] || {
  usage >&2
  exit 64
}
shift || true

case "$cmd" in
  build)
    container build -t "$IMAGE" "$@" "$ROOT"
    ;;
  login)
    prepare_paths
    ensure_auth_volume
    set_base_run_args
    container run --rm --interactive --tty "${BASE_RUN_ARGS[@]}" "$IMAGE" codex login --device-auth "$@"
    ;;
  run)
    prepare_paths
    ensure_auth_volume
    set_base_run_args
    if [[ "$#" -eq 0 ]]; then
      set -- sh
    fi
    container run --rm "${BASE_RUN_ARGS[@]}" "$IMAGE" "$@"
    ;;
  up)
    prepare_paths
    ensure_auth_volume
    set_base_run_args
    container run --detach --name "$CONTAINER_NAME" --publish 127.0.0.1:4500:4500 "${BASE_RUN_ARGS[@]}" "$IMAGE"
    ;;
  down)
    container stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    container delete "$CONTAINER_NAME" >/dev/null 2>&1 || true
    ;;
  ps)
    container list
    ;;
  logs)
    container logs "$CONTAINER_NAME"
    ;;
  inspect)
    container inspect "$CONTAINER_NAME"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage >&2
    exit 64
    ;;
esac
