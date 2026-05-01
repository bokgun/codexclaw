#!/usr/bin/env bash
set -euo pipefail

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

PORT="${CODEXCLAW_PORT:-4500}"
TOKEN_FILE="${CODEXCLAW_CODEX_TOKEN_FILE:-.codexclaw/codex.token}"
LISTEN_URL="${CODEXCLAW_CODEX_WS:-ws://127.0.0.1:${PORT}}"

if [[ ! -f "$TOKEN_FILE" ]]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  umask 077
  openssl rand -hex 32 > "$TOKEN_FILE"
  echo "Created token file: $TOKEN_FILE" >&2
fi

if [[ -L "$TOKEN_FILE" ]]; then
  echo "Refusing symlink token file: $TOKEN_FILE" >&2
  exit 1
fi

chmod go-rwx "$TOKEN_FILE"

TOKEN_FILE="$(cd "$(dirname "$TOKEN_FILE")" && pwd)/$(basename "$TOKEN_FILE")"

exec codex app-server \
  --listen "$LISTEN_URL" \
  --ws-auth capability-token \
  --ws-token-file "$TOKEN_FILE"
