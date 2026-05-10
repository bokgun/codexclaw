# Local Deployment

This path runs codexclaw and `codex app-server` on the same machine with a
loopback WebSocket. It is the fastest development smoke, but it is not the
recommended shape for channel adapters or shared hosts. For user-facing setup,
prefer starting with [Container Reference](./container.md) so the app-server
runs behind explicit filesystem and network boundaries.

```sh
bun install
cp .env.example .env
```

Set the workspace if Codex should work somewhere other than this repository:

```env
CODEXCLAW_DEPLOYMENT_MODE=local_loopback
CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500
CODEXCLAW_CODEX_LISTEN=ws://127.0.0.1:4500
CODEXCLAW_WORKSPACE_ROOT=/path/to/project
CODEXCLAW_STATE_DIR=~/.codexclaw
```

Start the app-server helper:

```sh
bun run start:codex
```

In another shell, run the CLI and quit cleanly:

```sh
bun run cli
/quit
```

## Boundaries

`CODEXCLAW_WORKSPACE_ROOT` is the project directory where Codex runs. `CODEXCLAW_STATE_DIR` is codexclaw-owned state for the bearer token, SQLite database, thread pointers, labels, schedules, pending approval mappings, and prefs. Conversation bodies, tool calls, diffs, and approval histories stay in Codex rollout storage, not codexclaw storage.

By default, state is `~/.codexclaw`, outside the workspace. codexclaw refuses workspace-internal state, token, or database paths unless both settings are present:

```env
CODEXCLAW_DEPLOYMENT_MODE=local_dev
CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE=true
```

Use that only for disposable local tests. Do not use it for channel adapters or shared hosts.

## Token And Readiness

`bun run start:codex` starts `codex app-server` with `--ws-auth capability-token` and `--ws-token-file`. If the token file does not exist in local modes, the helper creates `<state-dir>/codex.token` with private permissions.

The app-server exposes `GET /readyz` on the same listener. For the default port:

```sh
curl -fsS http://127.0.0.1:4500/readyz
```

Keep local mode on loopback. Plaintext `ws://` is accepted only for loopback hosts; use [WSS Reverse Proxy](./wss-reverse-proxy.md) for any non-loopback access.
