# codexclaw

![codexclaw logo](./codexclaw.png)

codexclaw is a minimal host and client layer for `codex app-server`. It routes messages from channels such as a CLI, Telegram, or Discord into Codex threads and streams the results back.

codexclaw is an independent open-source client for Codex app-server. It is not affiliated with or endorsed by OpenAI.

Inspired by [nanoclaw](https://github.com/qwibitai/nanoclaw). The container-isolation and channel-adapter patterns originate there; codexclaw adapts them for the Codex ecosystem.

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

codexclaw stores only its own routing data: thread pointers, labels, statuses,
pending approval mappings, schedules, and prefs placeholders. Codex rollout
storage remains the source of truth for conversation bodies, tool calls, diffs,
and approval histories.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the PRD-based project roadmap.
