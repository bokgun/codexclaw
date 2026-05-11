# Container Reference

This repository includes reference Docker artifacts for running
`codex app-server` inside a container while keeping codexclaw on the host. The
artifacts are deployment examples, not a production image publishing pipeline.

Apple Container support is documented-only in this repository until a maintainer
records a smoke run with Apple Container. Use the same mount, token, auth, and
network boundaries described below if adapting the Docker image to that runtime.
The Apple-specific smoke criteria live in
[Apple Container Checklist](../apple-container-checklist.md).

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
workspace it may edit and a read-only token secret or single-file token mount;
it must not receive the codexclaw state directory or SQLite database.

## Docker Quick Start

Prepare the host-side paths first. The workspace path must be absolute and must
be the same path inside the container:

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

Build the reference image:

```sh
scripts/docker-compose-codex.sh build codex-app-server
```

Initialize Codex CLI authentication inside the isolated container-owned auth
volume if the app-server has not already been logged in there:

```sh
scripts/docker-compose-codex.sh run --rm codex-app-server codex login --device-auth
```

Prefer `--device-auth` for container login. It lets the operator complete the
browser/device-code step from the host while keeping the resulting Codex CLI
auth material in the isolated container-owned volume.

Check that the final non-root `codex` user can write to the mounted workspace:

```sh
scripts/docker-compose-codex.sh run --rm codex-app-server sh -lc 'touch .codexclaw-container-write-test && rm .codexclaw-container-write-test'
```

Start the app-server:

```sh
scripts/docker-compose-codex.sh up codex-app-server
```

From another host shell, check readiness and use host codexclaw against the
loopback-published app-server:

```sh
curl -fsS http://127.0.0.1:4500/readyz
CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500 bun run cli
```

Inside the CLI, run:

```text
/thread list
/skills list
/quit
```

The compose file publishes only `127.0.0.1:4500:4500`, bind-mounts only the
workspace, provides the token as a read-only Docker secret, and stores Codex CLI
auth/config in the `codex-app-server-home` named volume. It does not mount the
codexclaw state directory or SQLite database into the app-server container.
Use `scripts/docker-compose-codex.sh` instead of raw `docker compose` so relative
or legacy `.env` token paths are resolved exactly like codexclaw runtime paths
before Compose reads them.

The Dockerfile pins `@openai/codex@0.128.0`, installs Codex sandbox
prerequisites including `bubblewrap`, runs as UID/GID `10001`, and starts
`codex app-server` with:

```text
--listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /tmp/codexclaw/codex.token
```

The entrypoint reads the Docker secret as root, copies it to
`/tmp/codexclaw/codex.token` as a `0400` file owned by UID/GID `10001`, then
drops to the non-root `codex` user before starting app-server. The
container-internal `0.0.0.0` listener is required so Docker port forwarding can
reach the service. Host exposure remains loopback-only through compose.

On Linux, bind-mounted workspaces must be writable by container UID/GID `10001`
or Codex edits will fail even though readiness checks pass. Use a narrow host
ACL, a disposable validation workspace owned by UID/GID `10001`, or another
explicit permission setup for the intended project; do not solve this by
mounting broader host paths or running the app-server as root.

## Mount Layout

Keep workspace, state, token, and database boundaries separate:

| Role | Example mount | Access | Notes |
| --- | --- | --- | --- |
| Workspace | `/workspace` | read-write only where Codex should edit | Project files for `CODEXCLAW_WORKSPACE_ROOT`. Use the narrowest project mount that works, and keep the same absolute path visible to host codexclaw and the app-server container. |
| State directory | host-side state path | read-write by the codexclaw user | codexclaw-owned metadata and default parent for token/db. Do not mount this directory into the app-server container. |
| Token file | host-side token path, provided read-only to app-server | read-only after creation where feasible | Bearer token used by `codex app-server`. Docker compose provides it as a secret; the entrypoint copies it to a non-root-owned `0400` runtime file before dropping privileges. Must not be group/world readable on the host. |
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

App-server container mounts and secrets:

```text
/workspace -> /workspace, read-write only for the intended project
/Users/example/.codexclaw/codex.token -> /run/secrets/codex.token, read-only Docker secret
/run/secrets/codex.token -> /tmp/codexclaw/codex.token, copied 0400 before privilege drop
```

The checked-in `bun run start:codex` helper is a loopback helper for local
development. In the recommended container setup, start `codex app-server` inside
the container with an internal-only listener or loopback-only host publish that
codexclaw can reach. If you split codexclaw and app-server into separate
containers, do not use this helper as-is; start `codex app-server` with an
internal-only listener that your reverse proxy or codexclaw runtime can reach,
never with a public plaintext `ws://` listener.

codexclaw reads the host-side token file. The app-server container receives the
same token as a read-only Docker secret and uses it for bearer-token
authentication. For split-container setups, apply the same rule: give the
app-server only that token as a read-only secret or single-file mount. Do not
mount the codexclaw state directory or SQLite database into the app-server runtime.
`CODEXCLAW_CODEX_LISTEN` is used only by `bun run start:codex` in the runtime
that starts the local app-server helper.

## Codex Authentication Boundary

The default Docker path uses an isolated named volume for `/home/codex/.codex`.
Run
`scripts/docker-compose-codex.sh run --rm codex-app-server codex login --device-auth`
to authenticate that volume through the normal entrypoint, which fixes ownership
before dropping to the non-root `codex` user. This avoids mounting broad host
home directories, cloud credential directories, SSH agents, Docker sockets, or
unrelated host secrets into the app-server container.

A read-only secret/config mount may be used instead only if it is narrowly
scoped to Codex CLI authentication and does not include unrelated credentials.
Do not mount `$HOME`, `~/.ssh`, cloud provider credential folders, or the
codexclaw state directory as a shortcut.

## Runtime User And Filesystem

For deployed or shared containers, run the app-server as a non-root user. Set
the app-server container UID/GID so that user can write only the workspace paths
Codex is expected to edit and can read the provided token secret:

- the workspace paths Codex is expected to edit
- the read-only token secret or single-file token mount

The host-side codexclaw user owns `CODEXCLAW_STATE_DIR` and `CODEXCLAW_DB`.
Those paths stay outside the Codex-editable workspace and are not mounted into
the app-server runtime.

Use read-only mounts for source trees or dependency caches that Codex should
inspect but not edit. Mount only the project directories that are intended to be
inside Codex's workspace permissions. Do not mount host secrets, broad home
directories, Docker sockets, SSH agents, or cloud credential directories into
the workspace.

## Docker Inspection Checks

Use these checks during release smoke:

```sh
scripts/docker-compose-codex.sh ps
docker inspect "$(scripts/docker-compose-codex.sh ps -q codex-app-server)" \
  --format '{{json .NetworkSettings.Ports}}'
```

Confirm the host publish is `127.0.0.1:4500`, not `0.0.0.0:4500`. Also inspect
the compose file or container mounts and confirm only these app-server mounts
are present:

```text
CODEXCLAW_WORKSPACE_ROOT -> same absolute path, read-write
CODEXCLAW_CODEX_TOKEN_FILE -> /run/secrets/codex.token, read-only Docker secret
/tmp/codexclaw/codex.token -> runtime copy owned by UID/GID 10001
codex-app-server-home -> /home/codex/.codex
```

No codexclaw SQLite database, state directory, rollout history mirror, broad
home directory, SSH agent, cloud credential directory, or Docker socket should
be mounted into the app-server container.

The state directory and token file must not be symlinks. codexclaw refuses symlink state, token, and database paths. Avoid symlinks from the workspace into `/state` or from `/state` back into the workspace, because they blur the boundary between Codex-editable files and codexclaw-owned metadata.

## Apple Container Quick Start

The Apple Container reference wrapper mirrors the Docker wrapper path policy.
Use a checkout under a normal user directory, such as
`/Users/<name>/TempWorkspace/codexclaw`; Apple Container build context handling
has been observed to fail from `/private/tmp` by sending an empty build context.

Build the image:

```sh
scripts/apple-container-codex.sh build
```

Initialize Codex CLI authentication inside an Apple Container-owned named
volume:

```sh
scripts/apple-container-codex.sh login
```

The login command runs `codex login --device-auth` inside the container so the
operator can complete the browser/device-code step from the host while the
resulting Codex auth stays in the isolated Apple Container volume.

Check the runtime user, sandbox prerequisite, and workspace write access:

```sh
scripts/apple-container-codex.sh run sh -lc 'id && which bwrap && touch .codexclaw-apple-container-write-test && rm .codexclaw-apple-container-write-test'
```

Start the app-server:

```sh
scripts/apple-container-codex.sh up
```

From another host shell, check readiness and use host codexclaw against the
loopback-published app-server:

```sh
curl -fsS http://127.0.0.1:4500/readyz
CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500 bun run cli
```

Inspect or stop the Apple Container runtime:

```sh
scripts/apple-container-codex.sh inspect
scripts/apple-container-codex.sh logs
scripts/apple-container-codex.sh down
```

By default the wrapper uses image `codexclaw/codex-app-server:0.128.0`,
container name `codexclaw-codex-app-server`, and auth volume
`codexclaw-codex-app-server-home`. Apple Container directory bind mounts are
used for the token boundary: the wrapper copies the host token into a dedicated
`CODEXCLAW_STATE_DIR/apple-container-token/codex.token` staging directory and
mounts only that directory read-only at `/run/secrets`. It also mounts
`CODEXCLAW_WORKSPACE_ROOT` and the isolated Codex auth volume. It does not mount
the codexclaw state directory, SQLite database, host home directory, SSH agent,
cloud credential directories, Docker socket, or broad host secrets.

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
