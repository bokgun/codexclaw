# MCP Plugin Path Findings

Status: MCP direct client calls and turn-mediated MCP tool use both work.

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

OpenCandle-backed target:

```bash
bun run spike:opencandle-mcp
```

Optional authenticated turn-mediated probe:

```bash
CODEXCLAW_MCP_PROBE_COPY_AUTH=1 CODEXCLAW_MCP_PROBE_TURN=1 bun run spike:mcp-plugin-path
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

When `CODEXCLAW_MCP_PROBE_COPY_AUTH=1` is set, the probe copies only
`auth.json` from the configured Codex home into the temporary `CODEX_HOME` so a
normal model turn can be attempted without mutating global Codex config. The
temporary auth copy is deleted with the disposable app-server state.

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

## OpenCandle Server

The OpenCandle probe now targets the production slice server at
`plugins/opencandle/server.ts`. The older spike-only server remains under
`src/spike/opencandle-mcp-server.ts` as historical probe code.

It exposes:

- configured server name: `opencandle`
- MCP serverInfo name: `codexclaw-opencandle-mcp`
- tool name: `get_fear_greed`
- provider: OpenCandle `getFearGreedIndex`
- network provider: yes, OpenCandle currently uses `api.alternative.me`

The production slice server imports OpenCandle provider code from
`OPENCANDLE_ROOT`. The value must be an absolute path that resolves to an
existing local OpenCandle checkout; there is no developer-specific fallback
path. `OPENCANDLE_ROOT` is the only OpenCandle-specific environment variable
allowlisted by the descriptor.

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
- unauthenticated normal turn-mediated MCP probing is skipped by default unless
  `CODEXCLAW_MCP_PROBE_COPY_AUTH=1 CODEXCLAW_MCP_PROBE_TURN=1` is set.

Interpretation:

- MCP is reachable through a Codex app-server direct client call path for
  probe-only validation.
- MCP server discovery from disposable config is viable.
- Normal turn-mediated MCP tool use is viable when the temporary `CODEX_HOME`
  has Codex auth.

Current outcome category:

- `mcp_turn_mediated_viable` for the authenticated isolated run.
- This is sufficient evidence to prefer MCP as the next codexclaw plugin
  direction over client-side dynamic tool registration for the pinned
  app-server version.

The plugin boundary and minimum security gate are recorded in
`docs/plugin-boundary.md`.

## Turn-Mediated Validation

Authenticated toy target:

```bash
CODEXCLAW_MCP_PROBE_COPY_AUTH=1 CODEXCLAW_MCP_PROBE_TURN=1 bun run spike:mcp-plugin-path
```

Observed on 2026-05-12:

- temporary `CODEX_HOME` was used;
- only `auth.json` was copied into that temporary home;
- `codexclaw-toy` was discovered;
- direct diagnostic `mcpServer/tool/call` succeeded;
- model turn completed;
- two MCP item/progress events were counted;
- `mcpServer/elicitation/request` was received and declined fail-closed;
- raw MCP arguments and raw tool output were not logged or persisted by
  codexclaw.

Authenticated OpenCandle target:

```bash
CODEXCLAW_MCP_PROBE_TARGET=opencandle CODEXCLAW_MCP_PROBE_COPY_AUTH=1 CODEXCLAW_MCP_PROBE_TURN=1 bun src/spike/mcp-plugin-path-probe.ts
```

Observed on 2026-05-12:

- `opencandle` server was discovered;
- direct diagnostic call to `get_fear_greed` succeeded;
- model turn completed;
- two MCP item/progress events were counted;
- `mcpServer/elicitation/request` was received and declined fail-closed;
- OpenCandle provider use requires network access and is therefore a plugin
  metadata/security-gate field, not an implicit capability.

The probe records event counts only. It does not persist conversation text,
tool arguments, tool output, provider response bodies, or auth material.

Observed again on 2026-05-14 against the M5e production OpenCandle plugin
server path:

- the probe wrote `OPENCANDLE_ROOT` into the temporary app-server MCP config
  only for the OpenCandle target;
- `opencandle` server discovery succeeded;
- direct diagnostic `mcpServer/tool/call` for `get_fear_greed` succeeded;
- authenticated normal turn-mediated MCP use completed;
- two MCP events were observed during the normal turn;
- `mcpServer/elicitation/request` was received and declined fail-closed;
- raw MCP arguments, raw tool output, provider response bodies, conversation
  bodies, and auth material were not recorded by the probe.

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
