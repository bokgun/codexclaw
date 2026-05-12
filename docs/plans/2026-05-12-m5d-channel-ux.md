# M5d Channel UX Plan

Date: 2026-05-12

## Goal

Expose plugin inspection and explicit enablement through codexclaw channel
commands while keeping plugin security facts visible and keeping raw MCP tool
arguments, outputs, and Codex conversation data out of codexclaw state and
responses.

## References

- `AGENTS.md`
- `docs/workflows.md`
- `docs/plugin-boundary.md`
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`
- `src/runtime/router.ts`
- `src/channel/commands.ts`
- `src/plugins/registry.ts`
- `src/plugins/supervisor.ts`
- `src/store/pointer-store.ts`

## Scope

- Add channel-neutral plugin commands:
  - `/plugin list`
  - `/plugin status <id>`
  - `/plugin enable <id>`
  - `/plugin enable <id> --confirm`
  - `/plugin disable <id>`
- Render bounded plugin metadata for CLI, Telegram, and Discord through the
  existing router and channel sink path.
- Show network access, provider names, env requirements, missing env names, and
  fail-closed elicitation policy before enablement.
- Persist only explicit plugin enablement state already modeled by
  `PointerStore`.
- Include supervisor status when plugin supervision is configured, without
  making the UX depend on supervision being enabled.
- Add parser, routing, service, and focused tests for plugin command behavior.

## Non-Goals

- No plugin marketplace, remote plugin installation, or automatic plugin
  enablement.
- No MCP elicitation interaction UX.
- No raw MCP argument, raw MCP output, or Codex rollout inspection.
- No adapter-specific buttons, modals, or rich embeds in this milestone.
- No plugin process lifecycle changes beyond requesting the existing supervisor
  to reconcile after enablement changes, if available.

## Dependencies

- M5a descriptor validation and display sanitization must remain the only path
  for accepting descriptor-derived metadata.
- M5b local registry and `PointerStore` plugin enablement APIs must be reused
  for discovery, missing-env diagnostics, and state persistence.
- M5c supervisor snapshot and reconcile hooks must be treated as optional
  metadata/lifecycle signals. Channel UX must still work when supervision is
  disabled.
- Existing channel authorization must run before plugin commands are handled.
  Implementation must either reuse existing adapter command paths with tests or
  add explicit adapter-level coverage for `/plugin enable <id> --confirm` and
  `/plugin disable <id>`.
- Existing app-server MCP ownership remains unchanged. M5d must not introduce a
  new tool invocation path inside codexclaw.

## UX Contract

`/plugin list` shows one bounded line per discovered plugin plus a short summary
of invalid or duplicate descriptors. Each line must include id, enabled state,
registry status, and visible security markers such as network/provider use.

`/plugin status <id>` shows detailed bounded metadata for exactly one plugin:
display name, version, descriptor status, enablement state, source label,
server name, tool summaries, env variable names, missing required env names,
network/provider metadata, elicitation policy, diagnostics, and supervisor
state when known.

`/plugin enable <id>` is a preview step, not a mutation. It shows the same
security-relevant facts that will matter after enablement and instructs the
user to rerun with `--confirm` for an explicit state change.

`/plugin enable <id> --confirm` persists enablement for the descriptor id and
current version. If required env names are missing, the command may still
persist the explicit enablement, but the response must state that the plugin is
not runnable until those env names are configured. Invalid, duplicate, and
version-mismatched entries must not be enabled.

`/plugin disable <id>` persists disabled state. It should also work for stale
persisted ids that are no longer discoverable so users can clean up old
enablement state.

All responses are plain text and channel-neutral. Formatting must avoid raw JSON
payloads, raw tool schemas, raw env values, raw MCP arguments, raw MCP outputs,
conversation bodies, diffs, and approval histories.

## Security And State Boundaries

- Plugin descriptors remain untrusted input. All descriptor-derived display
  strings must pass through existing bounded sanitization or equivalent helpers.
- Env display is name-only. Values from `process.env` or channel/runtime env
  must never be rendered.
- Enablement writes use only `PointerStore.setPluginEnablement` with plugin id,
  optional version, enabled flag, and timestamps.
- The command service reads registry metadata through
  `discoverLocalPluginRegistry` and never reads Codex rollout storage.
- App-server owns MCP discovery and invocation. codexclaw only shows descriptor,
  enablement, and supervisor metadata.
- MCP elicitation remains fail-closed and is displayed as such; no channel
  prompt flow is introduced.
- Authorization remains adapter-owned. M5d adds commands after inbound messages
  have already passed existing channel authorization.

## Ordered Tasks

1. Add plugin command shapes to `src/channel/types.ts` and parser support in
   `src/channel/commands.ts`.
2. Add a small plugin command service under `src/plugins` that can render list
   and status responses and apply enable/disable mutations through an injected
   store interface.
3. Add `plugins` to `RouterOptions` and route `/plugin` commands from
   `src/runtime/router.ts` to the plugin command service.
4. Wire the command service in `src/runtime/host.ts` using current plugin env
   config, the pointer store, process env, and an optional supervisor snapshot
   provider.
5. After enablement mutations, request the existing supervisor to reconcile if
   plugin supervision is active. Failure to reconcile should be rendered as a
   bounded warning and must not roll back the persisted user intent.
6. Add focused parser, service, router, host, and store-adjacent tests.
7. Update `docs/plugin-boundary.md` and the M5 roadmap status after
   implementation completes.

## Expected Files Or Modules

- `src/channel/types.ts`
- `src/channel/commands.ts`
- `src/runtime/router.ts`
- `src/runtime/host.ts`
- `src/plugins/commands.ts` or `src/plugins/channel-ux.ts`
- `src/plugins/index.ts` if a barrel export is useful
- `test/channel/commands.test.ts`
- `test/plugins/plugin-commands.test.ts`
- `test/runtime/router.test.ts`
- `test/runtime/host.test.ts`
- `docs/plugin-boundary.md`
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`

## Type And Interface Sketches

The command service should depend on narrow interfaces rather than concrete
runtime classes:

- `PluginCommandService`
  - `list(): Promise<string>`
  - `status(pluginId): Promise<string>`
  - `previewEnable(pluginId): Promise<string>`
  - `confirmEnable(pluginId): Promise<string>`
  - `disable(pluginId): Promise<string>`
- `PluginCommandServiceOptions`
  - plugin config
  - pointer-store methods for list/get/set enablement
  - env reader
  - optional supervisor snapshot provider
  - optional reconcile callback
- `PluginCommand`
  - list action
  - status action with plugin id
  - enable action with plugin id and confirmation flag
  - disable action with plugin id

The store dependency should expose only plugin enablement methods, not thread,
task, wiki, or conversation data.

## Control Flow Pseudocode

Plugin command routing:

1. Router receives an inbound slash command.
2. If command is `/plugin`, parse action and arguments.
3. If plugin command service is not configured, return capability unavailable.
4. Dispatch to list, status, preview enable, confirm enable, or disable.
5. Send returned bounded text through the existing channel sink.

Enable confirmation:

1. Discover current local plugin registry.
2. Resolve the requested plugin id against valid registry entries and stale
   persisted enablement records.
3. Reject invalid, duplicate, and version-mismatched entries.
4. For preview, render security facts and confirmation instruction without
   mutating state.
5. For confirm, persist enabled state using descriptor id and version.
6. Request supervisor reconcile when available.
7. Render final state, missing env guidance, and bounded reconcile warning if
   reconcile was requested but failed.

Status rendering:

1. Discover registry entries.
2. Merge discovered metadata, persisted enablement, projection omission reason,
   and optional supervisor status by plugin id.
3. Render only bounded metadata fields.
4. Render env names and missing env names, never env values.
5. Omit raw MCP arguments, raw tool arguments, raw tool outputs, and raw JSON
   schemas.

## Validation Criteria

- `bun run typecheck`
- `bun test test/channel/commands.test.ts`
- `bun test test/plugins/plugin-commands.test.ts`
- `bun test test/runtime/router.test.ts`
- `bun test test/runtime/host.test.ts`
- Existing plugin registry, supervisor, and pointer-store tests still pass.
- `bun test`
- Manual smoke path:
  - `/plugin list`
  - `/plugin status <id>`
  - `/plugin enable <id>`
  - `/plugin enable <id> --confirm`
  - `/plugin disable <id>`

## Test Cases

- Parser accepts the planned `/plugin` forms and rejects unknown actions,
  missing ids, extra arguments, and malformed confirmation usage.
- Router returns capability unavailable when plugin UX is not configured.
- Router sends plugin command output through the existing text sink and does not
  start a Codex turn for plugin commands.
- Adapter authorization tests prove unauthorized Telegram and Discord messages
  cannot reach state-mutating plugin commands, or cite existing adapter tests
  that already cover the shared command dispatch path.
- List output includes enabled state, descriptor status, network/provider
  markers, and no env values.
- Status output includes tool summaries but not raw MCP tool argument/output
  payloads or raw schemas.
- Enable preview does not write store state.
- Enable confirm writes plugin id and version only.
- Enable confirm for invalid, duplicate, and version-mismatched entries is
  rejected.
- Enable confirm with missing required env names produces missing-env guidance
  and no env values.
- Disable works for discovered plugins and stale persisted plugin ids.
- Supervisor status is included when available and omitted cleanly when
  supervision is disabled or unavailable.
- Reconcile errors are bounded in the user response and do not undo persisted
  enablement.

## Risks And Unknowns

- `Router` currently has its own slash dispatch separate from
  `parseSlashCommand`; M5d should avoid creating divergent semantics by adding
  tests for both paths.
- The registry does not currently synthesize entries for stale persisted ids.
  The command service may need to merge `listPluginEnablement` results so stale
  enabled ids can be inspected and disabled.
- Supervisor construction order in `HostRuntime` may require a lazy snapshot and
  reconcile provider to avoid circular initialization.
- Channel text length constraints differ between Telegram and Discord. Initial
  rendering should be bounded and deterministic, with richer pagination deferred
  until a concrete limit is hit.
- Persisting enablement when required env names are missing preserves explicit
  user intent but can surprise users if they expect immediate runtime
  availability. The response must state the runtime consequence clearly.

## Review History

- Round 1: implementation-reviewer found missing authorization validation,
  missing Dependencies section, and missing full-suite test gate.
- Round 1 fixes: added Dependencies, authorization test expectations, and
  `bun test` validation.
