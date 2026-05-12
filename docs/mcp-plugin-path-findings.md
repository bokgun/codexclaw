# MCP Plugin Path Findings

Status: direct MCP client call works; turn-mediated MCP use remains pending.

Date: 2026-05-12

## Scope

This document records whether codexclaw host-side plugin tools can use Codex
app-server's MCP path instead of client-side dynamic tool registration.

This document does not authorize a production plugin bridge. Production
registry, long-lived MCP process supervision, channel UX for executable tools,
OpenCandle integration, and third-party plugin execution remain out of scope.

## Schema Surface

Candidate MCP protocol surface from generated schemas:

- Client requests:
  - `config/mcpServer/reload`
  - `mcpServerStatus/list`
  - `mcpServer/tool/call`
  - `mcpServer/resource/read`
  - `mcpServer/oauth/login`
- Server requests:
  - `mcpServer/elicitation/request`
- Server notifications:
  - `mcpServer/startupStatus/updated`
  - `item/mcpToolCall/progress`
  - `mcpServer/oauthLogin/completed`
- Thread items:
  - `mcpToolCall`

The active schema root contains nested `schemas/generated/v2` files. Those MCP
types are usable for this spike only after `bun run schema:verify` passes for
the pinned Codex CLI. Production code must continue to rely on the schema gate.

## Repeatable Probe

Script:

```bash
bun run spike:mcp-plugin-path
```

The script starts a disposable app-server with an isolated `HOME`, `CODEX_HOME`,
state directory, token file, WebSocket port, and MCP server config. The
generated config shape is:

```toml
[mcp_servers.codexclaw-toy]
command = "/absolute/path/to/bun"
args = ["/absolute/path/to/src/spike/mcp-toy-server.ts"]
```

The probe performs metadata-only checks:

- reload MCP server config;
- list MCP server status;
- confirm the toy server and tool are visible;
- call the toy tool directly through `mcpServer/tool/call`;
- call an unknown toy tool and record bounded failure shape;
- optionally run a disposable turn and record whether MCP progress/items appear.

The probe does not persist raw MCP arguments, outputs, conversation bodies,
diffs, command bodies, token values, approval decisions, or approval histories.
It keeps only event counts, terminal-method markers, and MCP event counts in
memory while waiting for the optional turn probe; it does not retain full
inbound RPC messages.
The probe starts app-server with an allowlisted environment containing only
basic process paths and the isolated `HOME`, `CODEX_HOME`, and temp directory.
It does not forward channel tokens or the full parent environment to app-server
or the toy MCP server. App-server stdout/stderr are counted by line only and are
not re-emitted as codexclaw-owned logs. `mcpServer/elicitation/request` is
declined, and other unexpected server requests receive a fail-closed unsupported
method response.

Direct `mcpServer/tool/call` is used only to prove app-server MCP reachability
in this spike. It is not approved as a production plugin execution path unless a
future plan adds explicit channel authorization, user confirmation, and policy
gating, or proves the normal Codex turn-mediated MCP path.

## Toy Server

The spike toy server is `src/spike/mcp-toy-server.ts`.

It exposes:

- configured server name: `codexclaw-toy`
- MCP serverInfo name: `codexclaw-mcp-toy`
- tool name: `codexclaw_echo_shape`
- deterministic bounded output based on input length

The toy server is not a production plugin host, does not use network, and does
not require secrets.

## Current Outcome

`bun run spike:mcp-plugin-path` was run on 2026-05-12. The script created an
isolated temporary `HOME`, `CODEX_HOME`, state directory, token file, and
loopback port, then started a disposable app-server for the probe.

Observed result:

- app-server loaded the toy MCP server from isolated `HOME/.codex/config.toml`;
- `config/mcpServer/reload` returned success with an empty object shape;
- `mcpServerStatus/list` listed `codexclaw-toy`;
- the listed toy server exposed one tool, `codexclaw_echo_shape`;
- direct `mcpServer/tool/call` for `codexclaw_echo_shape` succeeded;
- direct `mcpServer/tool/call` for an unknown server, unknown toy tool, and
  malformed arguments returned bounded error shapes;
- app-server emitted `mcpServer/startupStatus/updated` notifications;
- normal turn-mediated MCP probing was skipped by default because the isolated
  home does not include Codex auth tokens.

Interpretation:

- MCP is reachable through a Codex app-server direct client call path for
  probe-only validation.
- MCP server discovery from disposable config is viable.
- Normal turn-mediated MCP tool use was not proven in this run.
- Earlier unauthenticated isolated-home attempts completed without MCP
  progress/items after upstream model authentication failures. That result is
  not a definitive negative.

Current outcome category:

- `mcp_direct_call_viable_turn_pending` for this isolated repeatable run.
- A follow-up run using an authenticated isolated Codex home, or a deliberate
  auth-safe fixture, is required before declaring MCP viable for normal
  turn-mediated plugin architecture.

## Storage And Security Boundary

codexclaw-owned logs are limited to method names, bounded MCP shape summaries,
status values, bounded errors, and event counts. MCP payload summaries report
top-level type/count and a small allowlist of schema-owned field names; they do
not enumerate arbitrary tool-output object keys.

`mcpServer/elicitation/request` is declined by the probe. Unknown MCP
server-request families receive an unsupported-method response so the probe does
not accidentally approve or service an unreviewed request shape.

The app-server may emit its own remote plugin sync or model authentication
warnings during isolated-home probes. Those are Codex-owned logs, not
codexclaw-owned persisted data.
