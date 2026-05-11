#!/usr/bin/env sh
set -eu

SOURCE_TOKEN="${CODEXCLAW_CONTAINER_TOKEN_SOURCE:-/run/secrets/codex.token}"
RUNTIME_DIR="${CODEXCLAW_CONTAINER_RUNTIME_DIR:-/tmp/codexclaw}"
RUNTIME_TOKEN="${CODEXCLAW_CONTAINER_TOKEN_FILE:-$RUNTIME_DIR/codex.token}"

if [ ! -f "$SOURCE_TOKEN" ]; then
  echo "Missing Codex app-server token secret: $SOURCE_TOKEN" >&2
  exit 1
fi

mkdir -p "$RUNTIME_DIR" /home/codex/.codex
cp "$SOURCE_TOKEN" "$RUNTIME_TOKEN"
chown codex:codex "$RUNTIME_DIR" "$RUNTIME_TOKEN" /home/codex/.codex
chmod 0700 "$RUNTIME_DIR" /home/codex/.codex
chmod 0400 "$RUNTIME_TOKEN"

exec gosu codex "$@"
