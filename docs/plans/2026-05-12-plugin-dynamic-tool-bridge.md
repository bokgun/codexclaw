# Plugin Dynamic Tool Bridge Plan

## Goal

Add a staged plan for codexclaw plugin support by first verifying the Codex
app-server dynamic tool protocol, then using that evidence to define a
production host-side plugin bridge.

The immediate goal is not to build a marketplace or an OpenCandle provider
adapter. The immediate goal is to remove protocol uncertainty around
`DynamicToolSpec` registration and `item/tool/call` handling so codexclaw can
later expose host-owned tools without guessing the app-server contract.

## Source References

- `/Users/bokgun/Workspace/OpenCandle/docs/plans/2026-05-12-codexclaw-phase0-protocol-spike.md`
- `docs/seed/PRD.md`
  - §1 and §2.2: codexclaw is an independent thin host over Codex
    app-server, not a Codex patch.
  - §3.1 and §8.1: codexclaw stores routing metadata only; Codex rollout
    storage remains the source of truth for conversation content and tool
    calls.
  - §3.2 and §9: no Codex internals, model routing, sandbox weakening,
    approval bypass, or direct channel editing of `AGENTS.md`.
  - §6.3: generated schema and observed protocol findings are version-gated.
- `docs/M0-findings.md`
- `docs/workflows.md`
- `docs/skills.md`
- `AGENTS.md`
- `schemas/generated/ServerRequest.ts`
- `schemas/generated/InitializeCapabilities.ts`
- `schemas/generated/InitializeParams.ts`
- `schemas/generated/v2/DynamicToolSpec.ts` as a candidate dynamic-tool schema
  source only after the provenance task below resolves the M0 warning.
- `schemas/generated/v2/DynamicToolCallParams.ts` as a candidate dynamic-tool
  schema source only after provenance is resolved.
- `schemas/generated/v2/DynamicToolCallResponse.ts` as a candidate dynamic-tool
  schema source only after provenance is resolved.
- `schemas/generated/v2/DynamicToolCallOutputContentItem.ts` as a candidate
  dynamic-tool schema source only after provenance is resolved.
- `schemas/generated/v2/PluginDetail.ts`
- `schemas/generated/v2/PluginListResponse.ts`
- `src/codex/runtime-client.ts`
- `src/codex/ws-client.ts`

## Scope

In scope:

- Distinguish Codex native plugins from codexclaw host-side plugins.
- Inspect generated schemas and live app-server behavior for dynamic tool
  registration and call handling.
- Build a minimal toy dynamic tool protocol spike if a registration path is
  found.
- Document exact JSON-RPC method names, payload shapes, response shapes, and
  observed limitations.
- Define a production `DynamicToolRegistry` and `DynamicToolBridge` boundary
  only after the registration path is known.
- Define safety requirements for tool input validation, output bounding,
  cancellation, timeout, metadata-only logging, and no raw tool persistence.
- Keep Codex approval and sandbox policy delegated to app-server.

Out of scope:

- OpenCandle financial provider implementation.
- Runtime-neutral OpenCandle tool registry extraction.
- Full Codex native plugin marketplace management.
- Credential setup UX.
- Production host-side dynamic tool execution before PRD, README, and skills
  documentation explicitly accept that product boundary.
- Workflow orchestration beyond a single dynamic tool call bridge.
- Storing raw tool arguments, tool outputs, conversation bodies, tool calls,
  diffs, approval decisions, or approval histories in codexclaw storage.
- Any change that lets codexclaw bypass Codex sandbox or approval enforcement.
- Direct channel-command mutation of `AGENTS.md`.

## Terms

- Extension family: A display and ownership label used to avoid conflating
  Codex-owned extensions with codexclaw-owned metadata or tools.
- Product boundary decision: A documented update to the PRD, README, and skills
  docs that explicitly allows codexclaw to host dynamic tool execution under
  bounded conditions. Phase 1 production execution is blocked until this
  decision exists.
- Codex native plugin: A plugin managed by Codex app-server through
  `plugin/list`, `plugin/read`, `plugin/install`, and related marketplace
  metadata. Generated plugin schemas currently describe marketplace entries,
  skills, apps, and MCP server names.
- Host metadata capability: A codexclaw-owned, metadata-only capability shown
  for inspection. It is not executable and does not grant permissions.
- codexclaw host-side plugin: A codexclaw-owned module that can register
  host-executed dynamic tools if app-server exposes a supported registration
  path.
- Dynamic tool bridge: The codexclaw runtime boundary that may receive
  `item/tool/call`, finds a registered host tool, executes it under codexclaw
  limits, and returns a `DynamicToolCallResponse` only after protocol
  provenance and the product boundary decision are both satisfied.

## Current Evidence

- `ServerRequest` includes `item/tool/call` with `DynamicToolCallParams`.
- Active `ServerRequest` text includes an `item/tool/call` method arm, but the
  imported dynamic tool params live under `schemas/generated/v2`.
- M0 records `schemas/generated/v2` as a legacy snapshot outside the active
  protocol source until separate provenance is recorded. Therefore all v2
  dynamic tool shapes are candidate evidence, not authoritative evidence, until
  Phase 0 resolves schema provenance.
- Candidate dynamic tool schemas exist:
  - `DynamicToolSpec`
  - `DynamicToolCallParams`
  - `DynamicToolCallResponse`
  - `DynamicToolCallOutputContentItem`
- `DynamicToolSpec` has fields for optional namespace, name, description,
  input schema, and optional deferred loading.
- `DynamicToolCallParams` includes thread id, turn id, call id, namespace, tool,
  and JSON arguments.
- `DynamicToolCallResponse` returns output content items and a success boolean.
- `InitializeCapabilities` supports `experimentalApi`, but
  `CodexWsClient.connect()` currently sends initialize params without
  capabilities.
- `TurnStartParams` does not currently expose a dynamic tool spec field.
- `CodexRuntimeClient.handleServerRequest()` currently routes observed approval
  requests and responds to all other server requests as unsupported. Therefore
  codexclaw cannot host dynamic tools yet even though the call schema exists.
- `docs/skills.md` currently defines host skills as metadata-only and
  non-executable. Host-side dynamic tools must be introduced as a separate
  family rather than silently changing host skills into executable tools.

## Ordered Tasks

1. Resolve schema provenance before trusting dynamic tool shapes.
   - Re-run or inspect the active schema gate for the pinned Codex app-server.
   - Confirm whether `schemas/generated/v2` is now active generated output,
     nested active output, stale legacy output, or mixed generated output.
   - Update the protocol findings document with the result before any spike
     relies on `DynamicToolSpec`, `DynamicToolCallParams`,
     `DynamicToolCallResponse`, or output content item fields.
   - If provenance cannot be resolved, stop this plan at documentation and do
     not implement dynamic tool registration or call handling.

2. Confirm generated schema surface.
   - Map all dynamic tool-related generated schemas and their fields.
   - Search generated client request, notification, config, profile, app,
     plugin, MCP, and turn schemas for `DynamicToolSpec`.
   - Confirm whether the current schema exposes a client-sent registration
     method, initialize capability field, turn field, plugin field, app field,
     or config path.
   - Document whether `experimentalApi` changes the generated method surface or
     only gates runtime behavior.

3. Confirm live app-server registration surface.
   - Start app-server through the existing Bun helper.
   - Observe initialize behavior with and without `experimentalApi`.
   - Probe only documented or generated candidate request paths.
   - Record success, method-not-found, invalid-params, and unsupported shapes.
   - Do not persist raw prompts, raw tool inputs, raw outputs, diffs, or tool
     bodies during observation.
   - Add or document a repeatable `bun run spike:*` command or manual checklist
     with pass/fail artifacts before marking Phase 0 complete.

4. Decide Phase 0 outcome.
   - If a supported registration path exists, record exact request method,
     params, response, required initialize capability, and lifecycle timing.
   - If no registration path exists in the pinned app-server, record the blocker
     and the smallest viable next route:
     - app-server/schema upgrade;
     - Codex native plugin route;
     - MCP server route;
     - or a documented unsupported status.
   - Keep this decision in a protocol findings document before production
     implementation begins.

5. Define extension taxonomy.
   - Document three extension families:
     - `codex_native`;
     - `host_metadata`;
     - `host_dynamic_tool`.
   - Keep Codex native plugins app-server-owned.
   - Keep existing host skills metadata-only.
   - Make host dynamic tools a new runtime bridge family, not a mutation of the
     current skills inspection contract.

6. Build a toy dynamic tool spike only if registration is confirmed.
   - Add a minimal spike path for one host-owned toy tool.
   - Use a namespace reserved for codexclaw protocol testing.
   - Use a small JSON Schema input shape.
   - Return a bounded text response through `DynamicToolCallResponse`.
   - Ensure unknown tool calls fail closed with bounded output.
   - Keep the spike isolated from production channel adapters.
   - Run the toy probe in-process only. In-process execution is allowed for the
     built-in toy probe because it must not load third-party code or receive
     host secrets.

7. Observe call and response behavior.
   - Trigger the toy tool from a local CLI turn.
   - Confirm app-server sends `item/tool/call` to codexclaw.
   - Confirm codexclaw can respond successfully.
   - Confirm app-server behavior for unknown tool, invalid arguments, tool
     timeout, and tool failure.
   - Confirm normal approval requests still route through the existing approval
     bridge.

8. Require product boundary approval before production execution.
   - Update PRD, README, and skills docs to explicitly state whether
     codexclaw may host bounded dynamic tool execution.
   - If the product boundary is not accepted, constrain future work to protocol
     findings and Codex-native plugin/MCP alternatives.
   - Record the decision in review history before Phase 1 implementation.

9. Define production execution isolation.
   - Choose the execution model before Phase 1 or Phase 2:
     - built-in in-process tools only;
     - subprocess/worker execution with explicit environment allowlisting;
     - containerized plugin execution;
     - or no host-side execution.
   - Require timeout, cancellation, output bounding, metadata-only logs, and
     secret redaction tests for the selected model.
   - Do not pass host environment variables, channel bot tokens, app-server
     bearer tokens, or codexclaw state paths to third-party plugins by default.

10. Define production runtime boundary.
   - Introduce a small registry concept for host-side dynamic tools.
   - Keep registry ownership in runtime code, not channel adapters.
   - Keep channel adapters unaware of raw tool arguments and outputs.
   - Add a bridge concept that handles dynamic tool server requests separately
     from approval server requests.
   - Ensure cancellation, timeout, output size limits, input validation, and
     metadata-only logging are part of the bridge contract.

11. Define host-side plugin loading policy.
   - Start with explicit local configuration only.
   - Keep plugin enablement default-off until protocol and security behavior are
     validated.
   - Require namespace uniqueness and deterministic conflict handling.
   - Do not pass channel bot tokens or codexclaw secrets into plugin execution
     unless a later credential plan explicitly scopes that behavior.
   - Treat plugin-provided descriptions and schemas as untrusted data for logs
     and channel display.

12. Add channel inspection UX.
   - Extend `/skills list` or add a bounded `/tools list` only after the
     extension taxonomy is documented.
   - Show family, namespace, name, status, source label, and boundary.
   - Omit raw schemas, raw arguments, raw outputs, executable bodies, private
     absolute paths, token-like values, and dependency command bodies.

13. Add documentation and manual validation.
   - Document Codex native plugin support separately from codexclaw host-side
     plugin support.
   - Document the known registration path or blocker.
   - Document storage boundaries and logging redaction expectations.
   - Add a manual checklist for enabling a toy plugin, invoking it, and
     confirming no raw tool payloads are persisted.

## Dependencies

- Current generated Codex app-server schemas.
- `docs/schema-provenance.md` and the existing schema gate.
- Current `CodexWsClient` initialize path.
- Current `CodexRuntimeClient` server request handling.
- Existing approval bridge behavior.
- Existing read-only skills inspection surface.
- Existing Bun app-server helper and spike patterns.
- A disposable workspace for protocol probes.
- PRD, README, and skills documentation updates for any production host-side
  execution boundary.

No OpenCandle credentials are needed for this plan.

## Expected Files Or Modules

Phase 0 documentation:

- `docs/plans/2026-05-12-plugin-dynamic-tool-bridge.md`
- `docs/M0-findings.md` or a new dynamic tool protocol findings document.
- A manual checklist entry or new checklist for plugin/dynamic tool validation.

Possible Phase 0 spike files:

- `src/spike/dynamic-tool-probe.ts`
- `docs/dynamic-tool-protocol-findings.md`
- `test/codex/dynamic-tool-protocol.test.ts`
- `test/runtime/dynamic-tool-bridge.test.ts`

Possible production files after Phase 0 succeeds:

- `src/runtime/dynamic-tools.ts`
- `src/runtime/dynamic-tool-bridge.ts`
- `src/runtime/plugin-registry.ts`
- `src/skills/host-registry.ts`
- `src/channel/commands.ts`
- `src/config/env.ts`
- `src/codex/runtime-client.ts`
- `src/codex/ws-client.ts`
- `docs/skills.md`
- `docs/slash-commands.md`
- `README.md`

These production files remain blocked until schema provenance, product boundary,
and execution isolation decisions are all complete.

## Type And Interface Sketches

These are design sketches only. Names and fields should be finalized after the
protocol spike confirms registration behavior.

```ts
type DynamicToolNamespace = string;
type DynamicToolName = string;

type ExtensionFamily = "codex_native" | "host_metadata" | "host_dynamic_tool";

type HostDynamicToolStatus = "enabled" | "disabled" | "registration_unavailable" | "error";

interface HostDynamicToolSummary {
  family: "host_dynamic_tool";
  namespace: DynamicToolNamespace;
  name: DynamicToolName;
  description: string;
  status: HostDynamicToolStatus;
  sourceLabel: string;
  boundary: "json_rpc_response_only";
}

interface HostDynamicToolSpec {
  namespace: DynamicToolNamespace;
  name: DynamicToolName;
  description: string;
  inputSchema: unknown;
  outputLimitBytes: number;
  timeoutMs: number;
}

interface DynamicToolExecutionContext {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: DynamicToolNamespace | null;
  toolName: DynamicToolName;
  signal: AbortSignal;
}

interface HostDynamicToolResult {
  success: boolean;
  contentItems: Array<{
    type: "inputText" | "inputImage";
    text?: string;
    imageUrl?: string;
  }>;
}

interface HostDynamicTool {
  spec: HostDynamicToolSpec;
  execute(args: unknown, context: DynamicToolExecutionContext): Promise<HostDynamicToolResult>;
}

interface DynamicToolRegistry {
  listSpecs(): readonly HostDynamicToolSpec[];
  listSummaries(): readonly HostDynamicToolSummary[];
  find(namespace: string | null, name: string): HostDynamicTool | undefined;
}
```

## Pseudocode

```text
on codex app-server connection initialize:
  require active schema provenance before using dynamic tool shapes
  send currently required client info
  include experimental capability only if Phase 0 proves it is required
  register dynamic tool specs only through a verified app-server path

on host startup:
  load Codex native plugin metadata only through app-server-owned methods
  load existing host metadata capabilities as non-executable entries
  load host dynamic tool descriptors only when explicitly enabled
  validate namespace and tool name uniqueness
  if dynamic tool registration is unavailable:
    mark host dynamic tools registration_unavailable
    do not advertise them as callable
  if product boundary decision is missing:
    keep production host dynamic tool execution disabled
  if execution isolation model is missing:
    keep third-party host dynamic tool execution disabled

on server request:
  if request method is an observed approval method:
    route through existing approval bridge
    stop

  if request method is item/tool/call:
    route through dynamic tool bridge
    stop

  respond unsupported
  emit metadata-only unknown event

on dynamic tool call:
  parse thread id, turn id, call id, namespace, tool name, and JSON arguments
  find host tool by namespace and tool name
  if not found:
    return bounded failed DynamicToolCallResponse

  validate arguments against the registered schema
  execute with timeout and cancellation
  bound output content items
  return DynamicToolCallResponse
  log only namespace, tool name, status, duration, and bounded error shape

on channel extension listing:
  fetch Codex skills through skills/list
  merge host metadata capability summaries
  merge host dynamic tool summaries
  render bounded metadata only
```

## Validation Criteria

Schema and protocol:

- Active schema provenance is resolved before any dynamic tool shape is treated
  as authoritative.
- Dynamic tool schema map is documented.
- Registration path is documented with exact method/config/capability names, or
  explicitly marked unavailable in the pinned app-server.
- `experimentalApi` behavior is observed and documented.
- Codex native plugin schemas are documented separately from codexclaw
  host-side plugin plans.
- A repeatable `bun run spike:*` command or manual checklist records pass/fail
  artifacts for live registration and call behavior.

Taxonomy:

- Docs distinguish `codex_native`, `host_metadata`, and `host_dynamic_tool`.
- Existing host skills remain metadata-only and non-executable.
- Host dynamic tools are not advertised as callable when registration is
  unavailable.

Spike behavior:

- Toy tool specs can be registered, if registration is available.
- Toy tool call reaches codexclaw as `item/tool/call`.
- Toy tool returns a successful `DynamicToolCallResponse`.
- Unknown tool, invalid args, timeout, and thrown error fail closed with bounded
  output.
- Existing approval request behavior still works.
- The toy spike does not load third-party code and does not receive host
  environment secrets.

Storage and logging:

- SQLite stores no raw tool arguments, raw tool outputs, conversation bodies,
  tool calls, diffs, approval decisions, or approval histories.
- Logs contain no raw tool inputs, raw outputs, tokens, authorization headers,
  command bodies, or diffs.
- Any persisted plugin data is limited to codexclaw-owned configuration,
  enablement, namespace metadata, and non-secret pointers.

Security:

- Production host dynamic tool execution does not start until PRD, README, and
  skills docs explicitly accept the boundary change.
- Third-party host plugin execution does not start until the execution isolation
  model is selected and validated.
- codexclaw does not weaken Codex sandbox or approval behavior.
- Dynamic tool execution does not receive channel bot tokens by default.
- Plugin descriptions, schemas, outputs, and errors are treated as untrusted.
- `AGENTS.md` remains a trust-boundary file and is not directly mutated through
  channel commands.
- Unknown server requests remain fail-closed.

Commands:

```bash
bun run typecheck
bun test
bun run schema:verify
bun run spike:dynamic-tool
```

If `bun run spike:dynamic-tool` is not implemented during Phase 0, the manual
checklist must explain why and must record equivalent pass/fail evidence.

## Risks And Unknowns

- The current app-server may expose dynamic call schemas without exposing a
  client registration path.
- `schemas/generated/v2` may remain non-authoritative for the pinned app-server.
- Dynamic tools may require Codex native plugin installation rather than
  client-side host registration.
- `experimentalApi` may be required but insufficient for registration.
- A future schema/app-server upgrade may change request or response names.
- Tool argument and output logging can accidentally violate codexclaw's storage
  boundary unless metadata-only logging is explicit from the first bridge.
- Host-side plugins can become an implicit credential boundary. Credential
  passing must remain out of scope until a separate credential plan exists.
- In-process third-party plugins would be able to inspect host process state and
  environment unless a stricter execution model prevents it.
- Channel adapters may be tempted to expose plugin behavior directly. Runtime
  ownership should keep adapters thin.
- Existing `/skills list` semantics may become confusing if executable dynamic
  tools are shown beside non-executable skills. The extension taxonomy and
  output labels must make boundaries explicit.

## Phase Gates

Phase 0 is complete when one of these is true:

- A toy dynamic tool is registered, called, answered, and documented end to end.
- The registration path is unavailable, and the blocker plus next viable route
  are documented with evidence.

Phase 0 is not complete until schema provenance is resolved and live behavior is
recorded by a repeatable spike command or manual checklist.

Phase 1 may begin only after Phase 0 completes and the product boundary decision
explicitly accepts codexclaw-hosted dynamic tool execution. Phase 1 should
implement the production registry and bridge for the verified route.

Phase 2 may begin only after Phase 1 has a selected execution isolation model,
bounded execution, validation, metadata-only logging, and tests. Phase 2 can
then introduce real host-side plugins such as an OpenCandle adapter.

## Review History

| Round | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 0 | main | 2026-05-12 | draft | Initial codexclaw plugin plan derived from the OpenCandle Phase 0 dynamic tool protocol spike plan. |
| 1 | planner | 2026-05-12 | incorporated | Added PRD/M0/skills references, extension taxonomy, channel inspection UX, and explicit host metadata versus host dynamic tool boundaries. |
| 2 | implementation-reviewer | 2026-05-12 | incorporated | Added product-boundary gate, v2 schema provenance gate, production execution isolation gate, and live spike/manual validation requirement. |
