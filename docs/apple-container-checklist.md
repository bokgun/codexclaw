# Apple Container Checklist

Use this checklist to validate an Apple Container runtime path for
`codex app-server`. This is separate from the Docker reference path. Do not mark
Apple Container support as smoke-verified until every required item below has
been completed and recorded in release notes.

The exact Apple Container CLI commands may change across Apple Container
versions. Record the Apple Container version, macOS version, and final commands
used during the smoke run.

## 1. Runtime Prerequisites

- [x] Install Apple Container on the validation host.
- [x] Confirm the Apple Container runtime is available:

  ```sh
  container --version
  ```

- [x] Record:
  - macOS version
  - Apple Container version
  - CPU architecture
  - whether the runtime supports image builds from a Dockerfile
  - whether the runtime supports loopback-only host publishing
  - whether the runtime supports read-only single-file mounts or secrets
  - whether the runtime supports setting a non-root user

## 2. Fresh Workspace And Host Paths

- [x] Create a disposable validation workspace outside the development checkout.
- [x] Clone the repository into the disposable workspace.
- [x] Run:

  ```sh
  bun install
  bun run schema:verify
  bun run typecheck
  bun test
  ```

- [x] Export absolute host paths. The workspace path must be the same absolute
  path on the host and inside the Apple Container runtime:

  ```sh
  export CODEXCLAW_WORKSPACE_ROOT=/absolute/path/to/project
  export CODEXCLAW_STATE_DIR="$HOME/.codexclaw"
  export CODEXCLAW_CODEX_TOKEN_FILE="$CODEXCLAW_STATE_DIR/codex.token"
  ```

- [x] Confirm the state directory is outside the workspace.
- [x] Confirm neither the state directory nor token path is a symlink.
- [x] Create the token file if needed:

  ```sh
  mkdir -p "$CODEXCLAW_STATE_DIR"
  chmod 700 "$CODEXCLAW_STATE_DIR"
  umask 077
  test -f "$CODEXCLAW_CODEX_TOKEN_FILE" || openssl rand -hex 32 > "$CODEXCLAW_CODEX_TOKEN_FILE"
  chmod 600 "$CODEXCLAW_CODEX_TOKEN_FILE"
  ```

## 3. Image Or Runtime Unit Build

- [x] Build an Apple Container-compatible runtime image or unit from the
  repository `Dockerfile`, or document the equivalent build artifact used.

  ```sh
  scripts/apple-container-codex.sh build
  ```
- [x] Confirm the build pins Codex CLI to the same version as the repository
  schema gate.
- [x] Confirm the app-server command uses capability-token auth and a token file:

  ```text
  codex app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file <runtime-token-path>
  ```

- [x] Confirm the runtime token path is not inside the mounted workspace.
- [x] Confirm the runtime starts the app-server as a non-root user if Apple
  Container supports it.

## 4. Mount And Secret Boundary

- [x] Mount only `CODEXCLAW_WORKSPACE_ROOT` read-write at the same absolute path
  inside the runtime.
- [x] Provide `CODEXCLAW_CODEX_TOKEN_FILE` through a read-only token staging
  mount or runtime secret.
- [x] Keep `CODEXCLAW_STATE_DIR` outside the Apple Container runtime.
- [x] Keep `CODEXCLAW_DB` outside the Apple Container runtime.
- [x] Do not mount broad host paths such as `$HOME`, `~/.ssh`, cloud credential
  directories, shell histories, Docker sockets, SSH agents, or unrelated host
  secrets.
- [x] Confirm Apple Container inspect output or equivalent runtime metadata shows
  only the intended workspace mount, token mount/secret, and isolated Codex auth
  storage.

## 5. Codex Authentication Boundary

- [x] Initialize Codex CLI authentication inside Apple Container-owned isolated
  auth storage.

  ```sh
  scripts/apple-container-codex.sh login
  ```
- [x] Do not satisfy authentication by mounting the operator's whole host home
  directory.
- [x] Confirm Codex auth is stored in the isolated Apple Container auth volume,
  not a host auth config mount.
- [x] Record the exact authentication initialization command used.

## 6. Runtime Smoke

- [x] Start `codex app-server` inside Apple Container.

  ```sh
  scripts/apple-container-codex.sh up
  ```
- [x] Confirm plaintext app-server access is loopback-only or internal to the
  runtime namespace. Do not expose `ws://` on all host interfaces.
- [x] Check readiness from the host:

  ```sh
  curl -fsS http://127.0.0.1:4500/readyz
  ```

- [x] Confirm the runtime user can write to the mounted workspace:

  ```sh
  scripts/apple-container-codex.sh run sh -lc 'id && which bwrap && touch .codexclaw-apple-container-write-test && rm .codexclaw-apple-container-write-test'
  ```

- [x] Prefer a runtime-internal write probe when Apple Container supports
  executing a shell in the app-server runtime. The probe must create and remove
  a file inside `CODEXCLAW_WORKSPACE_ROOT` as the same user that runs Codex.

## 7. Host codexclaw Smoke

- [x] Configure host codexclaw to use the Apple Container app-server endpoint:

  ```sh
  export CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500
  ```

- [x] Start the CLI:

  ```sh
  bun run cli
  ```

- [x] Run:

  ```text
  /thread list
  /skills list
  /quit
  ```

- [x] Confirm `/thread list` returns known pointers or a clear empty-state
  message.
- [x] Confirm `/skills list` shows Codex skills and host capabilities without
  leaking private absolute paths or dependency details.
- [ ] Optionally run one minimal prompt smoke in a disposable workspace and
  confirm Codex can edit only the intended workspace.

## 8. Release Record

- [x] Record all final Apple Container commands used for build, run, inspect,
  authentication, readiness, and cleanup.

  ```sh
  container --version
  sw_vers
  uname -m
  bun run schema:verify
  bun run typecheck
  bun test
  scripts/apple-container-codex.sh build
  scripts/apple-container-codex.sh login
  scripts/apple-container-codex.sh run sh -lc 'id && which bwrap && test -r /run/secrets/codex.token && test -d /home/codex/.codex && touch .codexclaw-apple-container-write-test && rm .codexclaw-apple-container-write-test'
  scripts/apple-container-codex.sh up
  scripts/apple-container-codex.sh inspect
  scripts/apple-container-codex.sh logs
  curl -fsS http://127.0.0.1:4500/readyz
  CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500 bun run cli
  scripts/apple-container-codex.sh down
  ```
- [x] Record Apple Container inspect output or an equivalent mount/network
  summary.

  ```text
  workspace: /Users/bokgun/TempWorkspace/codexclaw -> same path, read-write
  token: /Users/bokgun/TempWorkspace/codexclaw-state/apple-container-token -> /run/secrets, read-only
  auth: codexclaw-codex-app-server-home -> /home/codex/.codex, Apple Container volume
  publish: 127.0.0.1:4500 -> 4500/tcp
  no broad host home, SSH agent, cloud credential directory, Docker socket, codexclaw state dir, or SQLite mount
  ```
- [x] Record whether Apple Container support is:
  - `smoke_verified`, because required build, auth, mount, readiness, CLI
    `/thread list`, CLI `/skills list`, and CLI `/quit` smoke passed
  - optional minimal prompt smoke remains unrun
- [x] Stop and remove the Apple Container runtime unit.

  ```sh
  scripts/apple-container-codex.sh down
  ```
- [x] Confirm the disposable workspace contains only expected files.

## 9. Optional M5 Plugin Smoke

This is separate from the base Apple Container app-server smoke above. Do not
use this section to claim full M5 plugin completion unless the checks are
actually run and dated.

- [ ] Materialize the OpenCandle descriptor in the codexclaw checkout:

  ```sh
  bun run plugin:materialize:opencandle
  ```

- [ ] Configure plugin env in the runtime layout being tested:

  ```sh
  export CODEXCLAW_PLUGIN_DIRS=local-plugins
  export CODEXCLAW_PLUGIN_SUPERVISION_ENABLED=true
  export OPENCANDLE_ROOT=/absolute/path/to/OpenCandle
  ```

- [ ] Confirm the generated descriptor command, Bun runtime, codexclaw
  checkout, managed Codex home/config, and `OPENCANDLE_ROOT` are visible to the
  app-server runtime that starts MCP servers.
- [ ] Confirm codexclaw, OpenCandle, generated descriptor inputs, and runtime
  tooling mounts are read-only unless they are intentionally the Codex-editable
  workspace for this smoke.
- [ ] Confirm no host global `CODEX_HOME`, whole codexclaw state directory,
  SQLite database, SSH/cloud credential directory, or broad host home directory
  is mounted for plugin smoke.
- [ ] Authenticate the managed plugin Codex home with `codex login --device-auth`
  in the Apple Container-owned auth volume or the explicitly shared managed
  home used for the plugin smoke.
- [ ] Run `/plugin list`.
- [ ] Run `/plugin status opencandle`.
- [ ] Run `/plugin enable opencandle`.
- [ ] Run `/plugin enable opencandle --confirm`.
- [ ] Ask Codex in a normal turn to use `get_stock_quote` from server
  `opencandle`.
- [ ] Confirm codexclaw logs and SQLite state remain metadata-only and do not
  contain raw MCP arguments, raw MCP output, env values, provider response
  bodies, conversation bodies, diffs, or approval history.
- [ ] Record whether the optional M5 plugin smoke was run separately from the
  base Apple Container app-server smoke.
