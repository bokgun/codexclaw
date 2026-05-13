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
- `security.providers`: `OpenCandle`, `alternative.me`
- `security.envAllowlist`: `OPENCANDLE_ROOT`

Runtime requirements:

- `OPENCANDLE_ROOT` must point to a local OpenCandle checkout.
- `OPENCANDLE_ROOT` must be an absolute path that resolves to an existing
  directory.
- The server imports `src/providers/fear-greed.ts` from that checkout only when `get_fear_greed` is called.
- Tests can inject a fixture provider through `createOpenCandleMcpServer({ provider })`; no live network or OpenCandle checkout is required for fixture tests.

The generated descriptor intentionally contains no env values, provider responses, raw tool payloads, or user-specific OpenCandle fallback paths.
