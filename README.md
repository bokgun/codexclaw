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

## Local CLI Runtime

Install dependencies with Bun, start a Codex app-server, then run the M1 CLI
runtime:

```sh
bun install
cp .env.example .env
# Edit CODEXCLAW_WORKSPACE_ROOT in .env if Codex should work in another project.
bun run start:codex
bun run cli
```

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
directory stores codexclaw metadata such as thread pointers and pending approval
mappings. A future installer can ask for these paths interactively and write the
same settings to `.env`.

The M1 CLI path uses the shared runtime router, SQLite pointer store, thread
manager, approval bridge, and one-active-turn queue that future Telegram and
Discord adapters build on. The older spike scripts remain available under
`bun run spike:*` for protocol diagnostics.

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
- `CODEXCLAW_TELEGRAM_DELTA_FLUSH_MS`: streaming coalescing window, default `750`.
- `CODEXCLAW_TELEGRAM_API_BASE_URL`: Bot API base URL for tests or self-hosting.
- `CODEXCLAW_TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV=true`: local-only escape hatch for an empty allowlist.

M2 Telegram supports private chats only. Webhook signing and rate-limit
hardening are out of scope for the long-polling path; callback data carries only
opaque adapter keys and action names.

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
