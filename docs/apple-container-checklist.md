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

- [ ] Record:
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

- [ ] Mount only `CODEXCLAW_WORKSPACE_ROOT` read-write at the same absolute path
  inside the runtime.
- [ ] Provide `CODEXCLAW_CODEX_TOKEN_FILE` as a read-only single-file mount or
  runtime secret.
- [ ] Keep `CODEXCLAW_STATE_DIR` outside the Apple Container runtime.
- [ ] Keep `CODEXCLAW_DB` outside the Apple Container runtime.
- [ ] Do not mount broad host paths such as `$HOME`, `~/.ssh`, cloud credential
  directories, shell histories, Docker sockets, SSH agents, or unrelated host
  secrets.
- [ ] Confirm Apple Container inspect output or equivalent runtime metadata shows
  only the intended workspace mount, token mount/secret, and isolated Codex auth
  storage.

## 5. Codex Authentication Boundary

- [ ] Initialize Codex CLI authentication inside Apple Container-owned isolated
  auth storage.

  ```sh
  scripts/apple-container-codex.sh login
  ```
- [ ] Do not satisfy authentication by mounting the operator's whole host home
  directory.
- [ ] If a read-only Codex auth config mount is used, confirm it contains only
  Codex CLI authentication material and no unrelated credentials.
- [ ] Record the exact authentication initialization command used.

## 6. Runtime Smoke

- [ ] Start `codex app-server` inside Apple Container.

  ```sh
  scripts/apple-container-codex.sh up
  ```
- [ ] Confirm plaintext app-server access is loopback-only or internal to the
  runtime namespace. Do not expose `ws://` on all host interfaces.
- [ ] Check readiness from the host:

  ```sh
  curl -fsS http://127.0.0.1:4500/readyz
  ```

- [ ] Confirm the runtime user can write to the mounted workspace:

  ```sh
  scripts/apple-container-codex.sh run sh -lc 'id && which bwrap && touch .codexclaw-apple-container-write-test && rm .codexclaw-apple-container-write-test'
  ```

- [ ] Prefer a runtime-internal write probe when Apple Container supports
  executing a shell in the app-server runtime. The probe must create and remove
  a file inside `CODEXCLAW_WORKSPACE_ROOT` as the same user that runs Codex.

## 7. Host codexclaw Smoke

- [ ] Configure host codexclaw to use the Apple Container app-server endpoint:

  ```sh
  export CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500
  ```

- [ ] Start the CLI:

  ```sh
  bun run cli
  ```

- [ ] Run:

  ```text
  /thread list
  /skills list
  /quit
  ```

- [ ] Confirm `/thread list` returns known pointers or a clear empty-state
  message.
- [ ] Confirm `/skills list` shows Codex skills and host capabilities without
  leaking private absolute paths or dependency details.
- [ ] Optionally run one minimal prompt smoke in a disposable workspace and
  confirm Codex can edit only the intended workspace.

## 8. Release Record

- [ ] Record all final Apple Container commands used for build, run, inspect,
  authentication, readiness, and cleanup.
- [ ] Record Apple Container inspect output or an equivalent mount/network
  summary.
- [ ] Record whether Apple Container support is:
  - `smoke_verified`, if every required checklist item passed
  - `documented_only`, if any required item was skipped or unavailable
- [ ] Stop and remove the Apple Container runtime unit.

  ```sh
  scripts/apple-container-codex.sh down
  ```
- [ ] Confirm the disposable workspace contains only expected files.
