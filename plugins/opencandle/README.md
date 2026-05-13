# OpenCandle Plugin

This package is the production OpenCandle MCP plugin slice for codexclaw.

The checked-in `codexclaw-plugin.template.json` is not discoverable by the
registry. Generate a local descriptor first:

```sh
bun run plugin:materialize:opencandle
export CODEXCLAW_PLUGIN_DIRS=local-plugins
```

Generated descriptor shape:

- `id`: `opencandle`
- `mcp.serverName`: `opencandle`
- `mcp.command`: absolute path to the current Bun executable
- `mcp.args`: absolute path to `plugins/opencandle/server.ts`
- `mcp.env`: required `OPENCANDLE_ROOT`
- `security.network`: `declared`
- `tools`: `get_stock_quote`, `search_ticker`, `get_fear_greed`
- `security.providers`: `OpenCandle`, `Yahoo Finance`, `Alternative.me`
- `security.envAllowlist`: `OPENCANDLE_ROOT`

Runtime requirements:

- `OPENCANDLE_ROOT` must point to a local OpenCandle checkout.
- `OPENCANDLE_ROOT` must be an absolute path that resolves to an existing
  directory.
- Run `npm run build` in `OPENCANDLE_ROOT` first; the plugin delegates to
  `dist/codexclaw/mcp-server.js`.
- The wrapper calls OpenCandle's adapter handler and emits newline-delimited
  JSON-RPC for the pinned Codex app-server MCP path.
- Tests load a fixture adapter module from a temporary OpenCandle-like root; no
  live network or real OpenCandle checkout is required for unit tests.

The generated descriptor intentionally contains no env values, provider responses, raw tool payloads, or user-specific OpenCandle fallback paths.
