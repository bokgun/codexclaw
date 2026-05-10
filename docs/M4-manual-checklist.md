# M4 Manual Checklist

Use this checklist before cutting an M4 or v1.0 release candidate. It assumes
dependencies are installed locally and any remote-channel credentials are
available only in the operator's private environment.

## 1. Fresh Clone And Isolation Setup

- [ ] Create a disposable validation workspace outside the development checkout,
  for example `/Users/<name>/TempWorkspace/codexclaw-m4-smoke`.
- [ ] Clone the repository into that disposable workspace and enter it.
- [ ] Choose the app-server isolation path before installer setup: Docker
  Engine/Desktop, Apple Container, or an equivalent runtime. Use bare-metal
  `local_loopback` only as a development smoke fallback.
- [ ] Read [Container Reference](deploy/container.md) and decide the workspace,
  state, token, and SQLite mount locations before answering installer prompts.
- [ ] Use absolute paths when answering installer prompts. Do not put `~` in the
  middle of a path, because only a leading `~` is shell-expanded.
- [ ] If Codex reports that project-local config, hooks, or exec policies are
  disabled, record the warning by default. Trust project-local Codex config only
  after auditing those files and hooks, and only while running inside the
  selected isolated runtime without broad host secret mounts.
- [ ] Install dependencies:

  ```sh
  bun install
  ```

- [ ] Inspect the installer without writing files:

  ```sh
  ./codexclaw.sh --dry-run
  ```

- [ ] Confirm the dry-run summary redacts token and channel secret values.
- [ ] Run the installer:

  ```sh
  ./codexclaw.sh
  ```

- [ ] Confirm `.env` is created with private permissions.
- [ ] Confirm `CODEXCLAW_WORKSPACE_ROOT` points at the project Codex should
  inspect and edit, matching the container workspace mount if isolation is used.
- [ ] Confirm `CODEXCLAW_STATE_DIR` stays outside the workspace unless this is
  disposable local development with both local-dev opt-ins enabled.

## 2. Static Validation

- [ ] Verify the pinned app-server schema:

  ```sh
  bun run schema:verify
  ```

- [ ] Run typecheck:

  ```sh
  bun run typecheck
  ```

- [ ] Run tests:

  ```sh
  bun test
  ```

## 3. Container Isolation Preparation

- [ ] Build or prepare the reference container from [Container Reference](deploy/container.md).
- [ ] Mount only the project directory Codex should edit as the workspace.
- [ ] Confirm `CODEXCLAW_WORKSPACE_ROOT` is the same absolute path from host
  codexclaw and inside the app-server runtime.
- [ ] Keep codexclaw state and SQLite on the host or codexclaw runtime, outside
  the Codex-editable workspace.
- [ ] For split-container setups, mount only the read-only token file into the
  app-server runtime; do not mount the codexclaw state directory or SQLite
  database there.
- [ ] Confirm the container does not mount broad host paths such as `$HOME`,
  host secrets, Docker sockets, SSH agents, or cloud credential directories.
- [ ] Run the containerized app-server as a non-root user where the selected
  runtime supports it.
- [ ] Confirm plaintext `ws://` app-server access is loopback-only or internal
  to the container/network namespace. For Docker, do not publish with
  `-p 4500:4500`; bind to `127.0.0.1` or keep the service internal.
- [ ] For non-loopback or external access, expose only WSS through the reverse
  proxy and keep `CODEXCLAW_DEPLOYMENT_MODE=reverse_proxy_wss`.

## 4. App-Server Runtime Smoke

- [ ] Start the isolated app-server runtime selected in section 1. For the
  bare-metal development fallback, start the app-server helper:

  ```sh
  bun run start:codex
  ```

- [ ] Check readiness from another shell or from the host side of the selected
  runtime:

  ```sh
  curl -fsS http://127.0.0.1:4500/readyz
  ```

- [ ] Start the CLI:

  ```sh
  bun run cli
  ```

- [ ] Run:

  ```text
  /thread list
  ```

- [ ] Confirm known thread pointers are listed or an empty state is explained.
- [ ] Run:

  ```text
  /skills list
  ```

- [ ] Confirm Codex skills and host capabilities are shown with source/scope
  labels and without private absolute path or dependency detail leakage.
- [ ] Quit cleanly:

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
