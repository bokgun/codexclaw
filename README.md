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
bun run start:codex
bun run cli
```

Verify the pinned app-server schema before runtime work:

```bash
bun run schema:verify
```

Required environment:

- `CODEXCLAW_CODEX_WS`: Codex app-server WebSocket URL.
- `CODEXCLAW_CODEX_TOKEN_FILE`: file containing the bearer token used by the app-server. Defaults to `.codexclaw/codex.token`, which `bun run start:codex` creates automatically for local development.

The M1 CLI path uses the shared runtime router, SQLite pointer store, thread
manager, approval bridge, and one-active-turn queue that future Telegram and
Discord adapters build on. The older spike scripts remain available under
`bun run spike:*` for protocol diagnostics.

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
Gateway text is prompt text only, and text beginning with `/` is rejected with a
notice to use Discord slash commands.

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
