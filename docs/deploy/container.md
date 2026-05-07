# Container Reference

codexclaw does not publish a production image yet. This page documents the reference layout to use when building your own container or compose setup.

## Mount Layout

Keep workspace, state, token, and database boundaries separate:

| Role | Example mount | Access | Notes |
| --- | --- | --- | --- |
| Workspace | `/workspace` | read-write only where Codex should edit | Project files for `CODEXCLAW_WORKSPACE_ROOT`. Use the narrowest project mount that works. |
| State directory | `/state` | read-write by the codexclaw user | codexclaw-owned metadata and default parent for token/db. |
| Token file | `/state/codex.token` | read-only after creation where feasible | Bearer token used by `codex app-server`. Must not be group/world readable. |
| SQLite database | `/state/codexclaw.sqlite` | read-write | Thread pointers, labels, schedules, pending approval mappings, and prefs. |

Conversation bodies, raw tool calls, raw diffs, and approval histories are not codexclaw database data. They remain in Codex rollout storage.

## Environment

```env
CODEXCLAW_DEPLOYMENT_MODE=reverse_proxy_wss
CODEXCLAW_WORKSPACE_ROOT=/workspace
CODEXCLAW_STATE_DIR=/state
CODEXCLAW_CODEX_TOKEN_FILE=/state/codex.token
CODEXCLAW_DB=/state/codexclaw.sqlite
CODEXCLAW_CODEX_WS=wss://codex.example.com
CODEXCLAW_CODEX_LISTEN=ws://127.0.0.1:4500
```

The checked-in `bun run start:codex` helper is a loopback helper. In a container reference setup, run codexclaw and `codex app-server` in the same container or shared network namespace with a reverse proxy sidecar attached to that namespace. If you split codexclaw and app-server into separate containers, do not use this helper as-is; start `codex app-server` with an internal-only listener that your reverse proxy can reach, never with a public plaintext `ws://` listener.

Mount the same token file into the app-server container and the codexclaw runtime container; codexclaw only needs to read the token, while the app-server uses it for bearer-token authentication. `CODEXCLAW_CODEX_LISTEN` is used only by `bun run start:codex` in the container or namespace that starts the local app-server helper.

## Runtime User And Filesystem

For deployed or shared containers, run as a non-root user. Set the container UID/GID so that user owns or can write:

- `CODEXCLAW_STATE_DIR`
- `CODEXCLAW_DB`
- the workspace paths Codex is expected to edit

Use read-only mounts for source trees or dependency caches that Codex should inspect but not edit. Mount only the project directories that are intended to be inside Codex's workspace permissions. Do not mount host secrets, broad home directories, Docker sockets, SSH agents, or cloud credential directories into the workspace.

The state directory and token file must not be symlinks. codexclaw refuses symlink state, token, and database paths. Avoid symlinks from the workspace into `/state` or from `/state` back into the workspace, because they blur the boundary between Codex-editable files and codexclaw-owned metadata.

## Network Shape

Expose WSS at the reverse proxy only:

```text
internet
  -> reverse proxy :443 wss://codex.example.com
  -> loopback app-server ws://127.0.0.1:4500 inside the same container/network namespace
```

The app-server bearer token still applies behind the proxy. `/readyz` should be reachable through the proxy for deployment health checks:

```sh
curl -fsS https://codex.example.com/readyz
```

The container layout does not replace Codex sandboxing or approval behavior. codexclaw transports approval decisions and routes messages; Codex remains responsible for edits, tools, sandbox, approvals, and rollout storage.
