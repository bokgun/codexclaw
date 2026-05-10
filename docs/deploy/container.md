# Container Reference

codexclaw does not publish a production image yet. This page documents the reference layout to use when building your own container or compose setup.
The same boundaries apply whether the runtime is Docker Engine/Desktop, Apple
Container, or another container runtime.

Use this as the recommended starting point for user-facing setup. The local
loopback helper is convenient for development, but Telegram, Discord, shared
hosts, and non-loopback deployments should run `codex app-server` behind a
container/runtime boundary first.

## Recommended Shape

Run `codex app-server` inside the container runtime and keep codexclaw on the
host. Connect codexclaw to the container over loopback-only port forwarding or
an internal WebSocket endpoint. If anything outside the host/runtime namespace
needs to connect, terminate TLS at a reverse proxy and expose only `wss://`.

Until codexclaw has explicit host-to-container path mapping, use the same
absolute workspace path on the host and inside the app-server container. For
example, if `CODEXCLAW_WORKSPACE_ROOT=/workspace`, `/workspace` must exist on
the host and be bind-mounted to `/workspace` inside the app-server container.

Do not publish plaintext app-server access on every host interface. For Docker,
avoid `-p 4500:4500`; bind local-only access as `127.0.0.1:4500:4500`, or keep
the app-server on an internal container network behind a WSS reverse proxy.

The important part is not the specific runtime command; it is the boundary:
only the intended workspace is editable by Codex, codexclaw state is separate,
the bearer token is file-based and private, and broad host credentials are not
mounted.

Advanced variants, such as running codexclaw in a separate runtime unit, must
keep the same boundaries. The app-server runtime should receive only the
workspace it may edit and a read-only single-file token mount; it must not
receive the codexclaw state directory or SQLite database.

## Mount Layout

Keep workspace, state, token, and database boundaries separate:

| Role | Example mount | Access | Notes |
| --- | --- | --- | --- |
| Workspace | `/workspace` | read-write only where Codex should edit | Project files for `CODEXCLAW_WORKSPACE_ROOT`. Use the narrowest project mount that works, and keep the same absolute path visible to host codexclaw and the app-server container. |
| State directory | host-side state path | read-write by the codexclaw user | codexclaw-owned metadata and default parent for token/db. Do not mount this directory into the app-server container. |
| Token file | host-side token path, mounted read-only into app-server | read-only after creation where feasible | Bearer token used by `codex app-server`. Must not be group/world readable. |
| SQLite database | host-side DB path | read-write by codexclaw only | Thread pointers, labels, schedules, pending approval mappings, and prefs. Do not mount this into the app-server container. |

Conversation bodies, raw tool calls, raw diffs, and approval histories are not codexclaw database data. They remain in Codex rollout storage.

## Environment

Host-side codexclaw example:

```env
CODEXCLAW_DEPLOYMENT_MODE=reverse_proxy_wss
CODEXCLAW_WORKSPACE_ROOT=/workspace
CODEXCLAW_STATE_DIR=/Users/example/.codexclaw
CODEXCLAW_CODEX_TOKEN_FILE=/Users/example/.codexclaw/codex.token
CODEXCLAW_DB=/Users/example/.codexclaw/codexclaw.sqlite
CODEXCLAW_CODEX_WS=wss://codex.example.com
CODEXCLAW_CODEX_LISTEN=ws://127.0.0.1:4500
```

App-server container mounts:

```text
/workspace -> /workspace, read-write only for the intended project
/Users/example/.codexclaw/codex.token -> /run/secrets/codex.token, read-only single file
```

The checked-in `bun run start:codex` helper is a loopback helper for local
development. In the recommended container setup, start `codex app-server` inside
the container with an internal-only listener or loopback-only host publish that
codexclaw can reach. If you split codexclaw and app-server into separate
containers, do not use this helper as-is; start `codex app-server` with an
internal-only listener that your reverse proxy or codexclaw runtime can reach,
never with a public plaintext `ws://` listener.

codexclaw reads the host-side token file. The app-server container receives the
same token as a read-only single-file mount and uses it for bearer-token
authentication. For split-container setups, apply the same rule: give the
app-server only that token as a read-only single-file mount. Do not mount the
codexclaw state directory or SQLite database into the app-server runtime.
`CODEXCLAW_CODEX_LISTEN` is used only by `bun run start:codex` in the runtime
that starts the local app-server helper.

## Runtime User And Filesystem

For deployed or shared containers, run the app-server as a non-root user. Set
the app-server container UID/GID so that user can write only the workspace paths
Codex is expected to edit and can read the mounted token file:

- the workspace paths Codex is expected to edit
- the read-only token file mount

The host-side codexclaw user owns `CODEXCLAW_STATE_DIR` and `CODEXCLAW_DB`.
Those paths stay outside the Codex-editable workspace and are not mounted into
the app-server runtime.

Use read-only mounts for source trees or dependency caches that Codex should
inspect but not edit. Mount only the project directories that are intended to be
inside Codex's workspace permissions. Do not mount host secrets, broad home
directories, Docker sockets, SSH agents, or cloud credential directories into
the workspace.

The state directory and token file must not be symlinks. codexclaw refuses symlink state, token, and database paths. Avoid symlinks from the workspace into `/state` or from `/state` back into the workspace, because they blur the boundary between Codex-editable files and codexclaw-owned metadata.

## Network Shape

Expose WSS at the reverse proxy only:

```text
internet
  -> reverse proxy :443 wss://codex.example.com
  -> loopback or internal app-server ws://127.0.0.1:4500 inside the app-server runtime boundary
```

The app-server bearer token still applies behind the proxy. `/readyz` should be reachable through the proxy for deployment health checks:

```sh
curl -fsS https://codex.example.com/readyz
```

The container layout does not replace Codex sandboxing or approval behavior. codexclaw transports approval decisions and routes messages; Codex remains responsible for edits, tools, sandbox, approvals, and rollout storage.
