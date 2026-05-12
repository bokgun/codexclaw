# MCP Plugin Path Spike Plan

## Goal

Verify whether codexclaw host-side plugin tools can be exposed to Codex
app-server through MCP instead of client-side `DynamicToolSpec` registration.

The dynamic tool protocol spike found `item/tool/call` and `DynamicToolSpec`
schemas, but no generated client-side registration path. This plan tests the
next viable route: Codex app-server already knows MCP servers and MCP tool
calls, so codexclaw may be able to model host-side plugins as local MCP servers
without owning Codex tool registration.

## Source References

- `docs/plans/2026-05-12-plugin-dynamic-tool-bridge.md`
- `docs/dynamic-tool-protocol-findings.md`
- `docs/workflows.md`
- `docs/seed/PRD.md`
  - §1 and §2.2: codexclaw stays a thin host over `codex app-server`.
  - §3.1 and §8.1: codexclaw stores only routing metadata, schedules,
    pending approval mappings, and prefs.
  - §3.2 and §9: no Codex internals, model routing, sandbox weakening,
    approval bypass, or direct channel editing of `AGENTS.md`.
  - §6.3 and §16: schema and live protocol behavior must be measured before
    product implementation.
- `docs/M0-findings.md`
- `docs/skills.md`
- `AGENTS.md`
- `schemas/generated/ClientRequest.ts`
- `schemas/generated/ServerNotification.ts`
- `schemas/generated/ServerRequest.ts`
- `schemas/generated/v2/ListMcpServerStatusParams.ts` as a candidate MCP schema
  source only after the provenance task below resolves the M0 warning.
- `schemas/generated/v2/ListMcpServerStatusResponse.ts` as a candidate MCP
  schema source only after provenance is resolved.
- `schemas/generated/v2/McpServerStatus.ts` as a candidate MCP schema source
  only after provenance is resolved.
- `schemas/generated/v2/McpServerToolCallParams.ts` as a candidate MCP schema
  source only after provenance is resolved.
- `schemas/generated/v2/McpServerToolCallResponse.ts` as a candidate MCP schema
  source only after provenance is resolved.
- `schemas/generated/v2/McpResourceReadParams.ts` as a candidate MCP schema
  source only after provenance is resolved.
- `schemas/generated/v2/McpResourceReadResponse.ts` as a candidate MCP schema
  source only after provenance is resolved.
- `schemas/generated/v2/McpServerStatusUpdatedNotification.ts` as a candidate
  MCP schema source only after provenance is resolved.
- `schemas/generated/v2/McpToolCallProgressNotification.ts` as a candidate MCP
  schema source only after provenance is resolved.
- `schemas/generated/v2/PluginDetail.ts` as a candidate plugin/MCP schema source
  only after provenance is resolved.

## Scope

In scope:

- Inspect generated MCP schemas and app-server methods.
- Confirm how app-server discovers configured MCP servers.
- Determine whether a local toy MCP server can be configured without mutating
  user/global Codex config.
- Distinguish direct client MCP calls from model/turn-mediated MCP tool use.
- Run a disposable toy MCP server exposing one bounded tool.
- Verify `mcpServerStatus/list`, `config/mcpServer/reload`, and
  `mcpServer/tool/call` behavior against the toy server.
- Verify whether a normal Codex turn can see and invoke the toy MCP tool after
  server discovery.
- Record method names, payload shapes, status transitions, tool result shape,
  and failure behavior.
- Keep results metadata-only and avoid storing raw MCP arguments or outputs in
  codexclaw storage.

Out of scope:

- Production codexclaw plugin registry.
- Production dynamic tool bridge.
- OpenCandle provider integration.
- Third-party plugin execution.
- Codex native plugin marketplace install/uninstall flows.
- Persistent mutation of user-level Codex config.
- Credential setup UX or OAuth MCP flows.
- Persisting raw MCP tool arguments, outputs, conversation bodies, diffs,
  approval decisions, or approval histories.
- Weakening Codex sandbox, approval, or AGENTS.md trust-boundary behavior.

## Current Evidence

- Active `ClientRequest` text includes MCP methods, but many referenced MCP
  params and response shapes live under `schemas/generated/v2`.
- M0 records `schemas/generated/v2` as a legacy snapshot outside the active
  protocol source until separate provenance is recorded. Therefore v2 MCP
  shapes are candidate evidence, not authoritative evidence, until this spike
  resolves schema provenance.
- Candidate `ClientRequest` methods include:
  - `mcpServerStatus/list`;
  - `mcpServer/tool/call`;
  - `mcpServer/resource/read`;
  - `mcpServer/oauth/login`;
  - `config/mcpServer/reload`.
- Candidate `ServerNotification` methods include:
  - `mcpServer/startupStatus/updated`;
  - `item/mcpToolCall/progress`;
  - `mcpServer/oauthLogin/completed`.
- Candidate `ServerRequest` includes `mcpServer/elicitation/request`, which
  means MCP can produce user-facing requests that must fail closed unless
  explicitly handled with a verified generated response shape.
- `PluginDetail` contains `mcpServers`, suggesting Codex native plugins may
  expose MCP server declarations.
- `ThreadItem` includes an `mcpToolCall` item type with server, tool,
  arguments, result, and error fields. codexclaw must not persist those raw
  fields.
- `docs/dynamic-tool-protocol-findings.md` records that direct dynamic tool
  registration is unavailable in generated client schemas for pinned
  `codex-cli 0.128.0`.

## Ordered Tasks

1. Resolve MCP schema provenance before trusting v2 MCP shapes.
   - Run or inspect the active schema gate for pinned Codex app-server.
   - Confirm whether `schemas/generated/v2` is active generated output, nested
     active output, stale legacy output, or mixed generated output.
   - Update MCP findings with the result before relying on MCP params,
     responses, notifications, plugin `mcpServers`, or thread item shapes.
   - If provenance cannot be resolved, stop at documentation and do not
     implement MCP toy server or live MCP call handling.

2. Map generated MCP protocol surface.
   - Inspect active generated schemas for MCP status, tool call, resource read,
     reload, OAuth, elicitation, progress, and thread item types.
   - Record which methods are client requests, server notifications, and server
     requests.
   - Confirm whether `mcpServer/tool/call` is a client-initiated diagnostic
     call, a production tool call path, or both.

3. Identify disposable configuration path.
   - Determine whether app-server can load MCP servers from:
     - project-local `.codex` config;
     - explicit temporary `CODEX_HOME`;
     - profile/config layer;
     - plugin metadata;
     - or another generated config path.
   - Prefer an isolated temporary `CODEX_HOME` or disposable workspace.
   - Do not mutate the user's global Codex config.
   - Do not trust or edit `AGENTS.md`.

4. Build a toy MCP server spike.
   - Add a local spike server with exactly one bounded tool.
   - Tool behavior should be deterministic and not require network, secrets, or
     filesystem mutation outside the disposable workspace.
   - Tool input and output must be small and safe to summarize.
   - The server must be spike-only and not a production plugin host.

5. Build an MCP path probe.
   - Start the toy MCP server through the disposable app-server config.
   - Connect to Codex app-server with the existing WebSocket probe utilities.
   - Call `config/mcpServer/reload` if required by the observed config path.
   - Call `mcpServerStatus/list` with bounded detail.
   - Call `mcpServer/tool/call` for the toy tool if the server is ready.
   - Record only method names, shape summaries, status values, and dynamic
     yes/no observations.

6. Observe normal turn integration.
   - Start a disposable thread bound to the isolated workspace/config.
   - Ask Codex to use the toy MCP tool with an explicit prompt.
   - Confirm whether app-server emits `mcpToolCall` thread items or progress
     notifications.
   - Record whether Codex can call the tool autonomously, only through direct
     client request, or not at all.
   - Do not persist raw tool arguments, raw outputs, or conversation text.

7. Observe failure and security behavior.
   - Unknown MCP server.
   - Unknown tool.
   - Malformed arguments.
   - Tool failure.
   - Tool timeout or server startup failure.
   - MCP elicitation request, if the toy protocol can trigger one safely.
   - Confirm approval requests still use the existing approval bridge and that
     codexclaw does not make approval decisions.
   - Do not auto-accept new MCP approval or elicitation families unless a
     generated response mapping is deliberately added to the spike.
   - Validate that elicitation and unknown MCP server-request families either:
     - receive a safe decline/cancel only when a verified generated response
       shape exists; or
     - remain fail-closed and are not surfaced as approved channel UX.

8. Decide Phase 0 MCP outcome.
   - If MCP works as a host-side plugin path, record the minimum production
     shape as a future plan gate:
     - codexclaw plugin becomes an MCP server descriptor;
     - Codex app-server owns tool discovery and invocation;
     - codexclaw only configures or supervises the MCP process under explicit
       user opt-in.
   - If MCP cannot work without unsafe config mutation or global state, record
     the blocker and stop production plugin work.
   - If MCP works only through direct `mcpServer/tool/call` but not normal
     turns, record it as a diagnostic path, not a production plugin path.

9. Update findings and manual validation.
   - Add or update an MCP protocol findings document.
   - Add a repeatable `bun run spike:*` command or a manual checklist with
     pass/fail artifacts.
   - Keep findings free of raw MCP inputs, outputs, command bodies, secrets,
     diffs, and approval histories.

## Dependencies

- Existing WebSocket probe utilities.
- Existing `CodexWsClient` optional initialize capability support.
- Current generated Codex app-server schemas.
- `docs/schema-provenance.md` and the existing schema gate.
- Current app-server helper script.
- A disposable workspace and isolated Codex config/state path.
- Bun runtime.

No OpenCandle credentials are needed.

## Expected Files Or Modules

Plan and findings:

- `docs/plans/2026-05-12-mcp-plugin-path-spike.md`
- `docs/mcp-plugin-path-findings.md`

Possible spike files:

- `src/spike/mcp-plugin-path-probe.ts`
- `src/spike/mcp-toy-server.ts`
- `test/spike/mcp-plugin-path.test.ts`

Package scripts:

- `bun run spike:mcp-plugin-path`

Production runtime files are not expected to change in this spike.

## Type And Interface Sketches

```ts
interface McpToyToolDescriptor {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
}

interface McpProbeObservation {
  method: string;
  status: "success" | "error" | "skipped";
  shapeSummary: string;
  rawPayloadPersisted: false;
}

interface McpPathDecision {
  usableAsPluginPath: boolean;
  mode: "normal_turn" | "direct_client_call_only" | "config_blocked" | "auth_blocked" | "unsupported";
  configPath: "temporary_codex_home" | "project_local" | "plugin_metadata" | "unknown";
  blockers: readonly string[];
}
```

## Pseudocode

```text
prepare disposable workspace and Codex config:
  create temporary state/config root
  write minimal MCP server config if a safe config path is confirmed
  start app-server against disposable config

start toy MCP server:
  expose one deterministic tool
  avoid network, secrets, and durable output

probe MCP status:
  connect with codexclaw probe client
  request config/mcpServer/reload when needed
  request mcpServerStatus/list
  if toy server ready:
    request mcpServer/tool/call with bounded test args

probe normal turn:
  start disposable thread
  send prompt asking for toy MCP tool use
  wait for terminal turn
  scan event metadata for mcpToolCall/progress

record decision:
  if normal turn can call toy MCP:
    mark MCP path viable for future plugin architecture planning
  else if direct call only:
    mark MCP path diagnostic only
  else:
    mark unavailable with blocker evidence

server request handling:
  route observed command/file approvals through existing bridge only
  record mcpServer/elicitation/request as a bounded method/shape observation
  fail closed for unrecognized server request families
```

## Validation Criteria

Schema:

- MCP v2 schema provenance is resolved before any v2 MCP shape is treated as
  authoritative.
- MCP generated method/type map is documented.
- `mcpServer/tool/call` params and response shapes are summarized.
- `mcpServer/elicitation/request` handling risk is documented.

Config:

- Probe uses disposable workspace/config/state.
- Probe does not mutate user-level Codex config.
- Probe does not edit or trust `AGENTS.md`.

Live behavior:

- `mcpServerStatus/list` returns the toy server status or a bounded failure.
- `config/mcpServer/reload` behavior is recorded if used.
- Direct `mcpServer/tool/call` succeeds or fails with bounded evidence.
- Normal turn MCP tool availability is confirmed as usable, diagnostic-only, or
  unavailable.
- Startup failure, unknown server, and unknown tool behavior are recorded.
- Absence of a model tool call is not overclaimed as impossible unless status,
  config, or app-server evidence also shows the tool is unavailable.
- Elicitation and unknown MCP server-request families are safely declined with a
  verified response shape or left fail-closed without approved channel UX.

Storage and logs:

- No raw MCP arguments, outputs, conversation bodies, diffs, command bodies,
  token values, approval decisions, or approval histories are persisted.
- codexclaw-owned logs contain only method names, shape summaries, statuses,
  bounded errors, and event counts.

Commands:

```bash
bun run typecheck
bun test
bun run schema:verify
bun run spike:mcp-plugin-path
```

## Risks And Unknowns

- App-server may only load MCP servers from user/global Codex config, which
  would make automated safe probing harder.
- `schemas/generated/v2` may remain non-authoritative for the pinned
  app-server.
- Project-local MCP config may be disabled until the project is trusted.
- MCP tool calls may be available for direct client diagnostics but not as
  normal turn tools.
- MCP elicitation may require additional server-request handling before remote
  channels can safely expose it.
- Toy MCP server stdio protocol details may require a dependency or a small
  handcrafted server; the spike should choose the smallest reliable path.
- App-server-owned logs may include plugin/MCP startup warnings outside
  codexclaw's logger; findings should distinguish those from codexclaw
  persistence.
- Model nondeterminism may make turn-mediated tool observation inconclusive even
  when direct MCP calls work.

## Phase Gates

This spike is complete when one of these is true:

- MCP is proven viable for normal-turn tool discovery and invocation through a
  disposable toy server.
- MCP is proven direct-call-only and therefore not sufficient for production
  host-side plugin architecture.
- MCP setup is blocked by unsafe config mutation, trust requirements, missing
  protocol details, or app-server limitations, and that blocker is documented.

This spike is not complete until MCP schema provenance is resolved and MCP
elicitation/unknown server-request handling is verified as fail-closed.

Production plugin architecture remains blocked until this spike records one of
those outcomes and a separate implementation plan accepts the resulting
boundary.

## Review History

| Round | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 0 | main | 2026-05-12 | draft | Initial MCP plugin path spike plan following the dynamic tool registration blocker. |
| 1 | planner | 2026-05-12 | incorporated | Clarified PRD references, direct-call versus turn-mediated outcomes, fail-closed elicitation handling, and inconclusive model-call risk. |
| 2 | implementation-reviewer | 2026-05-12 | incorporated | Added MCP v2 schema provenance gate and explicit fail-closed validation for elicitation and unknown MCP server-request families. |
