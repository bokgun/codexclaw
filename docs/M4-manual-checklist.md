# M4 Manual Checklist

Use this checklist before cutting an M4 or v1.0 release candidate. It assumes
dependencies are installed locally and any remote-channel credentials are
available only in the operator's private environment.

## 1. Fresh Clone And Isolation Setup

- [x] Create a disposable validation workspace outside the development checkout,
  for example `/Users/<name>/TempWorkspace/codexclaw-m4-smoke`.
- [x] Clone the repository into that disposable workspace and enter it.
- [x] Choose the app-server isolation path before installer setup: Docker
  Engine/Desktop, Apple Container, or an equivalent runtime. Use bare-metal
  `local_loopback` only as a development smoke fallback.
- [x] Read [Container Reference](deploy/container.md) and decide the workspace,
  state, token, and SQLite mount locations before answering installer prompts.
- [x] Use absolute paths when answering installer prompts. Do not put `~` in the
  middle of a path, because only a leading `~` is shell-expanded.
- [x] If Codex reports that project-local config, hooks, or exec policies are
  disabled, record the warning by default. Trust project-local Codex config only
  after auditing those files and hooks, and only while running inside the
  selected isolated runtime without broad host secret mounts.
- [x] Install dependencies:

  ```sh
  bun install
  ```

- [x] Inspect the installer without writing files:

  ```sh
  ./codexclaw.sh --dry-run
  ```

- [x] Confirm the dry-run summary redacts token and channel secret values.
- [x] Run the installer:

  ```sh
  ./codexclaw.sh
  ```

- [x] Confirm `.env` is created with private permissions.
- [x] Confirm `CODEXCLAW_WORKSPACE_ROOT` points at the project Codex should
  inspect and edit, matching the container workspace mount if isolation is used.
- [x] Confirm `CODEXCLAW_STATE_DIR` stays outside the workspace unless this is
  disposable local development with both local-dev opt-ins enabled.

## 2. Static Validation

- [x] Verify the pinned app-server schema:

  ```sh
  bun run schema:verify
  ```

- [x] Run typecheck:

  ```sh
  bun run typecheck
  ```

- [x] Run tests:

  ```sh
  bun test
  ```

## 3. Container Isolation Preparation

- [x] Export absolute paths for the Docker reference. The workspace path must
  be the same absolute path on the host and inside the app-server container:

  ```sh
  export CODEXCLAW_WORKSPACE_ROOT=/absolute/path/to/project
  export CODEXCLAW_STATE_DIR="$HOME/.codexclaw"
  export CODEXCLAW_CODEX_TOKEN_FILE="$CODEXCLAW_STATE_DIR/codex.token"
  if [ -L "$CODEXCLAW_STATE_DIR" ]; then
    echo "Refusing symlink state dir: $CODEXCLAW_STATE_DIR" >&2
    exit 1
  fi
  case "$CODEXCLAW_CODEX_TOKEN_FILE" in
    "$CODEXCLAW_WORKSPACE_ROOT"/*)
      echo "Refusing workspace-internal token file: $CODEXCLAW_CODEX_TOKEN_FILE" >&2
      exit 1
      ;;
  esac
  ```

- [x] Create the host-side token file if the installer did not already create
  it:

  ```sh
  mkdir -p "$CODEXCLAW_STATE_DIR"
  chmod 700 "$CODEXCLAW_STATE_DIR"
  if [ -L "$CODEXCLAW_CODEX_TOKEN_FILE" ]; then
    echo "Refusing symlink token file: $CODEXCLAW_CODEX_TOKEN_FILE" >&2
    exit 1
  fi
  umask 077
  test -f "$CODEXCLAW_CODEX_TOKEN_FILE" || openssl rand -hex 32 > "$CODEXCLAW_CODEX_TOKEN_FILE"
  chmod 600 "$CODEXCLAW_CODEX_TOKEN_FILE"
  ```

- [x] Build the Docker reference container from
  [Container Reference](deploy/container.md):

  ```sh
  scripts/docker-compose-codex.sh build codex-app-server
  ```

- [x] If the isolated container Codex auth volume is not logged in, initialize
  it without mounting broad host credentials:

  ```sh
  scripts/docker-compose-codex.sh run --rm codex-app-server codex login --device-auth
  ```

- [x] Mount only the project directory Codex should edit as the workspace.
- [x] Confirm `CODEXCLAW_WORKSPACE_ROOT` is the same absolute path from host
  codexclaw and inside the app-server runtime.
- [x] Keep codexclaw state and SQLite on the host or codexclaw runtime, outside
  the Codex-editable workspace.
- [x] For split-container setups, provide only the read-only token secret or
  single-file token mount to the app-server runtime; do not mount the codexclaw
  state directory or SQLite database there.
- [x] Confirm the container does not mount broad host paths such as `$HOME`,
  host secrets, Docker sockets, SSH agents, or cloud credential directories.
- [x] Run the containerized app-server as a non-root user where the selected
  runtime supports it.
- [x] Confirm the non-root container user can write to the mounted workspace:

  ```sh
  scripts/docker-compose-codex.sh run --rm codex-app-server sh -lc 'touch .codexclaw-container-write-test && rm .codexclaw-container-write-test'
  ```

- [x] Confirm plaintext `ws://` app-server access is loopback-only or internal
  to the container/network namespace. For Docker, do not publish with
  `-p 4500:4500`; bind to `127.0.0.1` or keep the service internal.
- [x] Inspect the Docker publish and confirm it is loopback-only:

  ```sh
  docker inspect "$(scripts/docker-compose-codex.sh ps -q codex-app-server)" \
    --format '{{json .NetworkSettings.Ports}}'
  ```

- [ ] For non-loopback or external access, expose only WSS through the reverse
  proxy and keep `CODEXCLAW_DEPLOYMENT_MODE=reverse_proxy_wss`.
- [ ] Treat Apple Container as documented-only unless the same build, run,
  `/readyz`, CLI `/thread list`, CLI `/skills list`, CLI `/quit`, and optional
  minimal prompt smoke were completed with Apple Container and recorded in the
  release notes. Use the
  [Apple Container Checklist](apple-container-checklist.md) for that runtime.

## 4. App-Server Runtime Smoke

- [x] Start the isolated app-server runtime selected in section 1. For the
  Docker reference:

  ```sh
  scripts/docker-compose-codex.sh up codex-app-server
  ```

- [ ] For the bare-metal development fallback, start the app-server helper:

  ```sh
  bun run start:codex
  ```

- [x] Check readiness from another shell or from the host side of the selected
  runtime:

  ```sh
  curl -fsS http://127.0.0.1:4500/readyz
  ```

- [x] Start the CLI:

  ```sh
  bun run cli
  ```

- [x] Run:

  ```text
  /thread list
  ```

- [x] Confirm known thread pointers are listed or an empty state is explained.
- [x] Run:

  ```text
  /skills list
  ```

- [x] Confirm Codex skills and host capabilities are shown with source/scope
  labels and without private absolute path or dependency detail leakage.
- [x] Quit cleanly:

  ```text
  /quit
  ```

## 5. Remote Channel Smoke

- [ ] Configure exactly one remote channel with private credentials:
  Telegram or Discord.
- [ ] Confirm the channel has a non-empty user allowlist.
- [ ] Confirm `CODEXCLAW_TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV` or
  `CODEXCLAW_DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV` is not enabled outside
  explicit `local_dev` testing.
- [ ] Start the selected channel:

  ```sh
  bun run telegram
  ```

  or

  ```sh
  bun run discord
  ```

- [ ] Send a first message from an allowed user and confirm a Codex response.
- [ ] Send a message from a non-allowed user if safely available and confirm it
  is rejected before routing.

## 6. Deployment Notes

- [ ] For non-loopback access, use
  [WSS reverse proxy](deploy/wss-reverse-proxy.md) and confirm
  `CODEXCLAW_DEPLOYMENT_MODE=reverse_proxy_wss`.
- [ ] Confirm plaintext non-loopback `ws://` is not used.
- [ ] Confirm token files are private and not copied into URLs or logs.
- [ ] For containers, confirm workspace, state, token, and database mounts
  follow [Container Reference](deploy/container.md).
- [ ] For Raspberry Pi, follow
  [Raspberry Pi Smoke Path](deploy/raspberry-pi-smoke.md) and record Bun,
  Codex CLI, CPU architecture, and memory details for failures.

## 7. Release Review

- [ ] Review JSON-line stderr logs using [Logging](logging.md).
- [ ] Confirm codexclaw stores only pointer, label, schedule, approval mapping,
  and prefs data; Codex rollout storage remains the source of truth for
  conversation bodies, tool calls, diffs, and approval histories.
- [ ] Confirm no product command directly edits `AGENTS.md`.
- [ ] Confirm `git status --short` contains only intended release changes.
