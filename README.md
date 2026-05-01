# codexclaw

![codexclaw logo](./codexclaw.png)

codexclaw is a minimal host and client layer for `codex app-server`. It routes messages from channels such as a CLI, Telegram, or Slack into Codex threads and streams the results back.

codexclaw is an independent open-source client for Codex app-server. It is not affiliated with or endorsed by OpenAI.

Inspired by [nanoclaw](https://github.com/qwibitai/nanoclaw). The container-isolation and channel-adapter patterns originate there; codexclaw adapts them for the Codex ecosystem.

## M0 Spike

Install dependencies with Bun, start a Codex app-server, then run the REPL:

```sh
bun install
cp .env.example .env
bun run start:codex
bun run spike:repl
```

Required environment:

- `CODEXCLAW_CODEX_WS`: Codex app-server WebSocket URL.
- `CODEXCLAW_CODEX_TOKEN_FILE`: file containing the bearer token used by the app-server. Defaults to `.codexclaw/codex.token`, which `bun run start:codex` creates automatically for local development.

The initial spike is intentionally small. Its purpose is to verify WebSocket initialization, thread creation, turn streaming, approval behavior, cancellation, and reconnect semantics before building Telegram, Slack, scheduler, and pointer-store layers.
