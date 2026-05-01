#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EXPECTED_VERSION="$(bun -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); console.log(pkg.codexclaw.codexCliVersion);')"
SCHEMA_DIR="$(bun -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); console.log(pkg.codexclaw.appServerSchema.activeDirectory);')"
GENERATE_COMMAND="$(bun -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); console.log(pkg.codexclaw.appServerSchema.generateCommand);')"

ACTUAL_VERSION="$(codex --version 2>/dev/null | tail -n 1 | awk '{print $2}')"
if [[ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Schema Gate failed: codex CLI version mismatch" >&2
  echo "  expected: $EXPECTED_VERSION" >&2
  echo "  actual:   ${ACTUAL_VERSION:-unreadable}" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

codex app-server generate-ts --out "$TMP_DIR/generated" >/dev/null

DIFF_OUTPUT="$(diff -qr "$SCHEMA_DIR" "$TMP_DIR/generated" || true)"
FILTERED_DIFF="$(printf '%s\n' "$DIFF_OUTPUT" | grep -v "^Only in $SCHEMA_DIR: .gitkeep$" || true)"

if [[ -n "$FILTERED_DIFF" ]]; then
  echo "Schema Gate failed: checked-in schemas differ from generated output" >&2
  echo "  command: $GENERATE_COMMAND" >&2
  echo "$FILTERED_DIFF" >&2
  exit 1
fi

echo "Schema Gate passed: $SCHEMA_DIR matches codex-cli $EXPECTED_VERSION"
