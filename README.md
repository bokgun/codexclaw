# codexclaw

![codexclaw logo](./codexclaw.png)

codexclaw is a minimal host and client layer for `codex app-server`. It routes messages from channels such as a CLI, Telegram, or Discord into Codex threads and streams the results back.

It is also intended to be a forkable seed for building customized
Codex-powered agents. codexclaw provides adapters, routing, lightweight memory,
schedules, and preferences while delegating reasoning, tool execution, patches,
approvals, and rollout storage to Codex.

codexclaw is an independent open-source client for Codex app-server. It is not affiliated with or endorsed by OpenAI.

Inspired by [nanoclaw](https://github.com/qwibitai/nanoclaw). The container-isolation and channel-adapter patterns originate there; codexclaw adapts them for the Codex ecosystem.

## Vision

codexclaw should stay a thin, customizable shell around Codex: easy to fork,
easy to adapt to a person's or team's preferred agent workflow, and careful not
to reimplement Codex's core responsibilities.

Customize agent profiles, channel adapters, routing behavior, lightweight
memory, and local workflows. Leave editing, patching, model routing, sandbox
decisions, approval enforcement, conversation bodies, tool calls, diffs, and
approval histories to Codex.

The roadmap also reserves a post-M3, pre-M4 Knowledge Wiki milestone inspired
by the LLM-maintained wiki pattern: raw sources stay auditable, while the agent
compiles selected project knowledge into linked Markdown pages that humans can
inspect, edit, version, and review.

See [VISION.md](VISION.md) for the project vision.

## Fresh Clone Setup

Recommended setup starts with an isolated `codex app-server` runtime. Use
Docker Engine/Desktop, Apple Container, or an equivalent container runtime to
keep the Codex workspace, codexclaw state, bearer token, and database on clear
mount boundaries. See [Container reference](docs/deploy/container.md) before
running a remote channel.

Docker reference path:

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
scripts/docker-compose-codex.sh build codex-app-server
scripts/docker-compose-codex.sh run --rm codex-app-server codex login --device-auth
scripts/docker-compose-codex.sh run --rm codex-app-server sh -lc 'touch .codexclaw-container-write-test && rm .codexclaw-container-write-test'
scripts/docker-compose-codex.sh up codex-app-server
```

Use `scripts/docker-compose-codex.sh` rather than raw `docker compose`; it
resolves `.env` paths with the same workspace/state/token rules as codexclaw
before invoking Compose.
Use `codex login --device-auth` for container login so the browser/device-code
step happens on the host while the resulting Codex auth stays in the isolated
container volume.

In another shell, use host codexclaw against the loopback-only published
app-server:

```sh
curl -fsS http://127.0.0.1:4500/readyz
CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500 bun run cli
```

The Docker reference pins Codex CLI `0.128.0`, runs the app-server as a
non-root user, provides the token as a read-only Docker secret, keeps Codex auth
in an isolated container volume, and does not mount codexclaw state or SQLite
into the app-server container. Apple Container is documented-only until a smoke
run is recorded. On Linux, make sure the mounted workspace is writable by
container UID/GID `10001`; the write probe above verifies that before app-server
startup.

Apple Container reference path:

```sh
scripts/apple-container-codex.sh build
scripts/apple-container-codex.sh login
scripts/apple-container-codex.sh run sh -lc 'id && which bwrap && touch .codexclaw-apple-container-write-test && rm .codexclaw-apple-container-write-test'
scripts/apple-container-codex.sh up
```

The Apple Container wrapper uses the same workspace/state/token path rules as
the Docker wrapper, stores Codex auth in an Apple Container named volume, mounts
only the workspace and read-only token file, and publishes app-server on
`127.0.0.1:4500`.

Local smoke path:

Install dependencies with Bun, inspect the installer plan, then start a
loopback Codex app-server and CLI:

```sh
bun install
./codexclaw.sh --dry-run
./codexclaw.sh
bun run start:codex
bun run cli
```

Inside the CLI, useful first commands are:

```text
/thread list
/skills list
/quit
```

If you prefer manual setup, copy `.env.example` to `.env` and edit the same
settings there. Keep `/project` available for future multi-workspace routing;
use `CODEXCLAW_WORKSPACE_ROOT` for the project Codex should inspect and edit.

Bare-metal loopback setup is intended for development and first smoke tests.
For Telegram, Discord, shared hosts, or any non-loopback access, prefer the
container isolation path plus [WSS reverse proxy](docs/deploy/wss-reverse-proxy.md).
That path is: choose the container runtime, prepare the workspace/state/token/db
mounts from [Container reference](docs/deploy/container.md), run the installer
with matching absolute paths, then start the selected channel.

Verify the pinned app-server schema before runtime work:

```bash
bun run schema:verify
```

Required environment:

- `CODEXCLAW_CODEX_WS`: Codex app-server WebSocket URL.
- `CODEXCLAW_CODEX_LISTEN`: local `bun run start:codex` listen URL. Defaults to loopback `ws://127.0.0.1:4500`; keep WSS termination in a reverse proxy.
- `CODEXCLAW_WORKSPACE_ROOT`: project directory where Codex should run. Defaults to the directory where codexclaw is started and is created if missing.
- `CODEXCLAW_STATE_DIR`: codexclaw-owned state directory. Defaults to `~/.codexclaw`, supports `~/.codexclaw/...`, and is created with private permissions. Workspace-internal state requires explicit `CODEXCLAW_DEPLOYMENT_MODE=local_dev` and `CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE=true`.
- `CODEXCLAW_CODEX_TOKEN_FILE`: file containing the bearer token used by the app-server. Defaults to `<state-dir>/codex.token`, which `bun run start:codex` creates automatically for local development. Relative paths resolve from the state dir.
- `CODEXCLAW_DB`: SQLite database path for codexclaw pointers, approvals, tasks, and prefs. Defaults to `<state-dir>/codexclaw.sqlite`. Relative paths resolve from the state dir.
- `CODEXCLAW_VERIFIED_THREAD_FORK`, `CODEXCLAW_VERIFIED_THREAD_ARCHIVE`, `CODEXCLAW_VERIFIED_THREAD_UNARCHIVE`: keep false unless an external spike has verified the pinned app-server mutating thread methods in your environment. codexclaw's boot probe stays metadata-only and does not create, archive, or unarchive disposable threads.

`CODEXCLAW_WORKSPACE_ROOT` and `CODEXCLAW_STATE_DIR` are intentionally
separate. The workspace is the project Codex can inspect and edit; the state
directory stores codexclaw metadata such as thread pointers, labels, pending
approval mappings, schedules, and prefs.

The M1 CLI path uses the shared runtime router, SQLite pointer store, thread
manager, approval bridge, and one-active-turn queue that future Telegram and
Discord adapters build on. The older spike scripts remain available under
`bun run spike:*` for protocol diagnostics.

## Operations Docs

- [Local deployment](docs/deploy/local.md)
- [WSS reverse proxy](docs/deploy/wss-reverse-proxy.md)
- [Container reference](docs/deploy/container.md)
- [Raspberry Pi smoke path](docs/deploy/raspberry-pi-smoke.md)
- [Logging](docs/logging.md)
- [Skills inspection](docs/skills.md)
- [M4 manual checklist](docs/M4-manual-checklist.md)

## Knowledge Wiki

M3.5 adds an optional Markdown Knowledge Wiki for fork-specific, auditable
project knowledge. It is disabled by default and stores only human-reviewable
wiki pages, manifests, explicit user notes, and redacted lint reports under the
configured wiki root. It does not copy Codex rollout history, tool calls, diffs,
approval histories, or hidden conversation replicas.

```bash
CODEXCLAW_WIKI_ENABLED=true
CODEXCLAW_WIKI_ROOT=wiki
CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS=docs,README.md
bun run cli
```

Useful commands:

- `/wiki ingest [--public|--private] [--slug <slug>] <path...> [--focus <text>]`
- `/wiki note [--public|--private] <title> <body>`
- `/wiki capture-selected [--public|--private] [--slug <slug>] <selected text>`
- `/wiki query [--limit <n>] <query>`
- `/wiki with [--limit <n>] <query> -- <message>`
- `/wiki lint [--write-report]`

Wiki artifacts are either `project_public` or `user_private`. Private pages are
visible only to the owning `user_key` during query and context attachment. Wiki
context is attached as data-only text and sanitized like prefs; it cannot alter
Codex sandbox, approval, model routing, or AGENTS.md policy.
Relative wiki paths are resolved from `CODEXCLAW_WORKSPACE_ROOT`.

## Telegram Runtime

Telegram runs as a long-polling personal channel:

```bash
CODEXCLAW_TELEGRAM_BOT_TOKEN=123456:bot-token
CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS=123456789
bun run telegram
```

Required Telegram environment:

- `CODEXCLAW_TELEGRAM_BOT_TOKEN`: bot token from BotFather.
- `CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS`: comma-separated numeric Telegram user IDs.

Optional Telegram environment:

- `CODEXCLAW_TELEGRAM_POLLING_TIMEOUT_SECONDS`: long-poll timeout, default `30`.
- `CODEXCLAW_TELEGRAM_MODIFY_TIMEOUT_MS`: adapter reply collection timeout for Modify, default `600000`.
- `CODEXCLAW_TELEGRAM_DELTA_FLUSH_MS`: streaming coalescing window, default `10000`.
- `CODEXCLAW_TELEGRAM_API_BASE_URL`: Bot API base URL for tests or self-hosting.
- `CODEXCLAW_TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV=true`: local-only escape hatch for an empty allowlist.
- `CODEXCLAW_TELEGRAM_FILE_DELIVERY_ENABLED=true`: opt in to outbound document delivery for live Telegram turns.
- `CODEXCLAW_FILE_DELIVERY_ALLOWED_ROOTS`: comma-separated roots that outbound document delivery may read from. Relative paths resolve from `CODEXCLAW_WORKSPACE_ROOT`; empty means the workspace root.
- `CODEXCLAW_FILE_DELIVERY_MAX_BYTES`: max bytes for one outbound document, default `20971520` and capped at 49 MiB.
- `CODEXCLAW_FILE_DELIVERY_MAX_FILES`: max outbound documents per turn, default `3`.

M2 Telegram supports private chats only. Webhook signing and rate-limit
hardening are out of scope for the long-polling path; callback data carries only
opaque adapter keys and action names.
Approval callback memory-miss handling uses only the stored pending approval
mapping and Telegram prompt message id; it does not store prompt text, command
payloads, diffs, callback payload history, or approval decisions. Because the
pinned app-server protocol does not expose a server generation id, cold
`bun run telegram` restarts and rows from another host process fail closed until
a continuity proof is added. Expired recovered callbacks can only recover to a
safe decline, and recovered `Modify` rejects the original approval and asks for
a fresh instruction because the original Modify context is intentionally
in-memory only.

Outbound Telegram document delivery is host-layer only. Codex does not receive
the Telegram bot token or a Telegram send tool; codexclaw detects explicit file
delivery intent in a live Telegram turn, validates current-turn files reported
by successful completed Codex file-change metadata under the configured
allowed roots, and sends valid added files with `sendDocument` after the turn
completes. Scheduled tasks and unattended routes do not send documents.
Candidate paths, file contents, raw diffs, tool bodies, and delivery history
are not persisted by codexclaw.

## Discord Runtime

Discord v1 runs in personal mode only. DMs and bot mentions in guild channels
route by sender identity (`discord:<user-id>`); guild channel IDs are only
reply targets and are not shared team thread ownership. Signed HTTP
interactions are the only executable command, approval, and branch-button path.
Gateway text is prompt text by default. Text beginning with `/` is rejected with
a notice to use registered Discord slash commands, while the local personal-bot
shortcut `:threads` or `:thread switch work` is converted to the shared
`/threads` or `/thread switch work` router commands. New docs prefer the
explicit `/thread ...` command namespace so future `/project ...` commands can
manage multi-workspace routing without overloading `/new` or `/switch`.
Approval and branch-suggestion buttons also accept local text fallbacks such as
`1`, `2`, and `3 <instruction>` so personal bots can approve without a public
interaction endpoint.

```bash
CODEXCLAW_DISCORD_BOT_TOKEN=bot-token
CODEXCLAW_DISCORD_APPLICATION_ID=123456789012345678
CODEXCLAW_DISCORD_PUBLIC_KEY=64_hex_chars
CODEXCLAW_DISCORD_ALLOWED_USER_IDS=123456789012345678
bun run discord
```

Required Discord environment:

- `CODEXCLAW_DISCORD_BOT_TOKEN`: bot token used only by the host adapter.
- `CODEXCLAW_DISCORD_APPLICATION_ID`: application ID used for slash-command and mention routing.
- `CODEXCLAW_DISCORD_PUBLIC_KEY`: Discord interaction Ed25519 public key.
- `CODEXCLAW_DISCORD_ALLOWED_USER_IDS`: comma-separated Discord user IDs.

Optional Discord environment:

- `CODEXCLAW_DISCORD_ALLOWED_GUILD_IDS`: comma-separated guild allowlist. Empty allows DMs and any guild from an allowed user.
- `CODEXCLAW_DISCORD_INTERACTIONS_HOST`: interaction receiver host, default `127.0.0.1`.
- `CODEXCLAW_DISCORD_INTERACTIONS_PORT`: interaction receiver port, default `8787`.
- `CODEXCLAW_DISCORD_INTERACTIONS_PATH`: interaction receiver path, default `/discord/interactions`.
- `CODEXCLAW_DISCORD_DELTA_FLUSH_MS`: streaming coalescing window, default `750`.
- `CODEXCLAW_DISCORD_MODIFY_TIMEOUT_MS`: core Modify follow-up timeout, default `600000`.
- `CODEXCLAW_DISCORD_API_BASE_URL`: Discord API base URL for tests.
- `CODEXCLAW_DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV=true`: local-only escape hatch for an empty allowlist.

Credential and webhook assumptions: the interaction endpoint must be exposed to
Discord by your deployment or tunnel and Discord signatures are verified before
JSON parsing. Bot tokens and authorization headers are redacted from adapter
errors and are not passed to Codex app-server or spawned tool environments.
Discord API rate-limit retry/backoff is not implemented in this skeleton.

codexclaw stores only its own routing data: thread pointers, labels, statuses,
pending approval mappings, task definitions, schedules, run metadata, and prefs
placeholders. Scheduled task instructions are stored as task definition data and
should be treated as sensitive user content. Codex rollout storage remains the
source of truth for conversation bodies, tool calls, diffs, and approval
histories.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the PRD-based project roadmap.
