# M5c Process Supervision Plan

## Goal

Supervise enabled local MCP plugins by coordinating codexclaw's M5b registry
projection with `codex app-server` MCP reload/status surfaces, while keeping
Codex-owned tool calls, tool outputs, conversations, diffs, and approval
history out of codexclaw state and logs.

M5c treats `codex app-server` as the MCP server process owner. codexclaw owns
validated config projection, reload coordination, lifecycle observation,
bounded diagnostics, retry policy, and host shutdown/reconnect behavior.

## PRD And Roadmap References

- `docs/seed/PRD.md`
  - codexclaw remains a thin Bun + TypeScript host above `codex app-server`.
  - codexclaw stores only routing metadata, schedules, pending approval
    mappings, prefs, and codexclaw domain settings.
  - codexclaw does not persist conversation bodies, tool calls, diffs, approval
    histories, raw MCP arguments, or raw MCP output.
  - codexclaw does not weaken Codex sandboxing or approval behavior.
- `docs/plugin-boundary.md`
- `docs/mcp-plugin-path-findings.md`
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`
- `docs/plans/2026-05-12-m5b-local-registry-config-resolution.md`
- `docs/workflows.md`
- `AGENTS.md`

## Scope

In scope:

- Add MCP runtime client wrappers for:
  - `config/mcpServer/reload`;
  - `mcpServerStatus/list`.
- Convert `mcpServer/startupStatus/updated` notifications into metadata-only
  runtime events.
- Decline `mcpServer/elicitation/request` fail-closed without persisting
  request content.
- Render a managed app-server MCP config from M5b projection.
- Ensure the codexclaw-started app-server environment is sanitized before it can
  spawn MCP plugin children, unless implementation proves app-server replaces
  plugin child env exactly with descriptor `env`.
- Coordinate reload/status observation for enabled, valid, env-complete
  plugins.
- Track metadata-only supervisor status for desired state, observed state,
  bounded error summary, restart count, and transition time.
- Add bounded retry/backoff around reload/status observation failures.
- Integrate supervisor startup/reconcile/reconnect/close into `HostRuntime`.
- Add focused tests for disabled omission, failed startup/status, retry/backoff,
  reconnect, redaction, and non-blocking router behavior.

Out of scope:

- Directly spawning plugin processes from codexclaw.
- Remote plugin runtimes, plugin marketplace, downloads, installs, or updates.
- Channel commands such as `/plugin list`, `/plugin enable`, or `/plugin status`.
- Direct production `mcpServer/tool/call` UX.
- OpenCandle production plugin packaging.
- MCP elicitation UX beyond fail-closed decline.
- Containerized third-party plugin execution.
- Persisting plugin lifecycle history in SQLite.

## Supervision Boundary

M5c is app-server-managed supervision:

- codexclaw builds the desired MCP server config from M5b projection;
- codexclaw writes or supplies only the managed MCP config surface selected by
  implementation;
- codexclaw asks app-server to reload MCP config;
- app-server starts, stops, and owns MCP server processes;
- codexclaw observes app-server startup/status notifications and status-list
  responses.

Direct `spawn` from codexclaw remains out of scope unless a separate plan proves
the app-server-managed path cannot provide enough lifecycle control.

This is the M5c interpretation of process supervision: codexclaw supervises
local MCP plugin processes through app-server's MCP lifecycle boundary, not by
forking plugin commands itself. To satisfy the roadmap exit criteria, M5c must
prove that app-server reload/status can provide equivalent start, stop, restart,
failed-startup observation, bounded diagnostics, and clean shutdown semantics
for validated enabled local MCP servers. If that proof fails, implementation
must stop and produce a follow-up plan rather than adding partial supervision.

## Stop/Go Gates

Implementation must complete these gates before building the supervisor loop:

1. Config source gate.
   - Decide the exact config source app-server will read for MCP servers:
     codexclaw-owned managed config for codexclaw-started app-server, or
     explicit external app-server setup.
   - Record the files/scripts that pass that config source to app-server.
   - If neither path can be made explicit, stop M5c implementation.

2. Lifecycle semantics gate.
   - Verify reload/status can observe successful startup, failed startup,
     removal of disabled servers, and restart of an unchanged failed server.
   - Verify clean host shutdown stops observation and does not leave
     codexclaw-owned timers running.
   - If app-server does not provide enough lifecycle semantics, stop and plan a
     revised supervision boundary.

3. Environment inheritance gate.
   - Verify whether app-server plugin children inherit the app-server parent
     environment.
   - If child env is not proven to be exactly the configured MCP `env`, use a
     sanitized app-server parent environment before enabling managed
     supervision.

## Managed Config Policy

M5c must not silently mutate arbitrary global Codex config. Implementation must
choose one of these reviewed paths:

- state-owned managed Codex config included in the codexclaw-started
  app-server environment; or
- explicit external app-server setup where codexclaw only computes projection
  and invokes reload/status.

If managed config writing is implemented:

- write only MCP server entries derived from `AppServerMcpConfigProjection`;
- do not write disabled, invalid, duplicate, version-mismatched, or
  missing-env plugins;
- write only to a codexclaw state-owned managed config path;
- reject symlinked managed config paths and symlinked parent escapes;
- write atomically through a temporary file in the same private directory;
- require final config file permissions no broader than `0600`;
- require parent directory permissions no broader than `0700`;
- do not write raw MCP args/output, env values into codexclaw SQLite, or
  app-server bearer tokens into plugin config;
- document whether the managed config is persistent host state or temporary
  runtime state.

The codexclaw-started app-server environment must be allowlisted before MCP
plugins can be supervised through app-server. Channel bot tokens, app-server
bearer token files, codexclaw database/state paths, broad secret/token/password
variables, and unreviewed `CODEXCLAW_*` variables must not be inherited by
plugin children. If the pinned app-server guarantees plugin child env is exactly
the configured MCP `env`, M5c may rely on that only after recording the evidence
and adding a regression test or manual checklist item.

## Files Or Modules Expected To Change

Expected runtime changes:

- `src/codex/runtime-client.ts` for MCP reload/status wrappers,
  startup-status notification parsing, and metadata-only fail-closed handling
  for MCP server-request families.
- `src/runtime/host.ts` for supervisor lifecycle integration, with route
  acceptance kept independent from plugin reconciliation.
- `src/plugins/*` for supervisor types, config rendering, path safety checks,
  status summaries, and projection-to-config helpers.
- `src/config/env.ts` if managed config paths, supervisor limits, or sanitized
  app-server env settings become configurable.
- `scripts/start-codex-app-server.sh` only if the config source gate selects a
  codexclaw-started managed config path.

Expected tests and docs:

- focused tests under `test/codex`, `test/plugins`, `test/runtime`, and
  `test/config` as needed by the implementation split;
- `docs/plugin-boundary.md`, `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`,
  and `docs/ROADMAP.md` to record the app-server-managed interpretation of
  M5c supervision if validation succeeds.

## Types And Interfaces

Planned sketches:

```ts
type PluginSupervisorState =
  | "disabled"
  | "starting"
  | "ready"
  | "failed"
  | "backing_off"
  | "stopped";

interface PluginSupervisorConfig {
  startupTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxRestartAttempts: number;
  diagnosticMaxChars: number;
}

interface SupervisedPluginStatus {
  pluginId: string;
  version?: string;
  serverName: string;
  sourceLabel: string;
  desired: "running" | "stopped";
  state: PluginSupervisorState;
  restartCount: number;
  lastTransitionAt: string;
  lastErrorSummary?: string;
  missingEnvNames: readonly string[];
}

interface AppServerMcpStatusSummary {
  serverName: string;
  startupState?: "starting" | "ready" | "failed" | "cancelled" | "unknown";
  toolCount?: number;
  resourceCount?: number;
  errorSummary?: string;
}
```

Implementation may refine names, but status must stay metadata-only.

## Ordered Tasks

1. Confirm app-server supervision semantics with existing spike evidence.
   - Use `docs/mcp-plugin-path-findings.md` and the MCP spike implementation
     as the baseline.
   - If required, add a focused toy failure observation script or manual note
     before finalizing implementation.
   - Treat this as the lifecycle semantics gate. Record whether app-server
     reload/status can start, stop, restart, and observe failed startup for
     enabled local MCP servers.
   - Stop implementation if the app-server-managed lifecycle cannot satisfy the
     M5c roadmap exit criteria.

2. Add MCP runtime client boundary.
   - Add `CODEX_METHODS` entries for MCP reload/status.
   - Add typed wrapper methods for reload and status list.
   - Add metadata-only notification parsing for
     `mcpServer/startupStatus/updated`.
   - Handle `mcpServer/elicitation/request` fail-closed with a bounded decline
     response and no request-body persistence.
   - Handle all other unrecognized `mcpServer/*` server requests fail-closed
     with metadata-only runtime events; do not emit raw request params.

3. Add supervisor status types and summary helpers.
   - Extend plugin types or add a `src/plugins/supervisor.ts` module.
   - Status includes plugin id, version, server name, source label, desired
     state, observed state, restart count, transition time, missing env names,
     and bounded error summary.
   - Status does not include env values, raw stdout/stderr, raw MCP args, raw
     MCP output, provider responses, diffs, or conversation content.

4. Add managed app-server MCP config rendering.
   - Render only from `AppServerMcpConfigProjection`.
   - Keep output shape close to the validated app-server TOML shape:
     `[mcp_servers.<serverName>]`, `command`, `args`, and allowlisted `env`.
   - Provide tests that omitted projection entries do not appear.
   - Keep any rendered config out of SQLite and redact env values from logs.
   - Enforce state-owned path, non-symlink writes, atomic same-directory
     replacement, `0600` file permissions, and `0700` parent directory
     permissions.
   - Add app-server environment allowlist or record evidence that app-server
     does not pass parent env through to plugin children.
   - Complete the config source gate before wiring reload/reconcile behavior.

5. Add supervisor reconcile loop.
   - Desired state comes from M5b registry/projection.
   - Observed state comes from runtime MCP status list and startup-status
     notifications.
   - Reload app-server MCP config when desired projection changes or on
     reconnect.
   - Use bounded startup timeout and capped backoff for reload/status failures.
   - Mark repeated failure as terminal until projection changes or host restart.
   - Plugin failures must not block normal router/channel operation.

6. Integrate with `HostRuntime`.
   - Initialize supervisor after Codex transport connects, but do not await
     plugin reload/status beyond a strict startup budget before accepting normal
     routes.
   - Prefer route acceptance first or fire-and-observe reconciliation if the
     first plugin reload/status pass is slow or failing.
   - Reconcile after reconnect.
   - Stop timers and observation on host close.
   - Do not add channel commands in M5c.
   - Keep scheduler/router behavior independent of plugin failures.

7. Add focused tests.
   - Runtime client wrappers call the expected methods.
   - Elicitation requests are declined fail-closed.
   - Unknown `mcpServer/*` server requests fail closed without raw params in
     emitted events or logs.
   - Managed config writes reject symlinks and denied roots, use private
     permissions, and do not mutate global Codex config.
   - App-server environment passed to plugin-capable app-server startup is
     allowlisted, or app-server exact-env replacement is explicitly verified.
   - Disabled, invalid, duplicate, version-mismatched, and missing-env plugins
     never reach reload/config output.
   - Ready, failed, timeout, retry/backoff, and reconnect paths update
     metadata-only status.
   - Failed plugin startup does not prevent core routing in a fake host test.
   - Host startup accepts normal routing even when initial plugin reload/status
     is slow, failing, or backing off.
   - Logs/status do not contain env values, raw MCP payloads, provider response
     bodies, stdout/stderr bodies, diffs, or conversation text.

8. Update docs after implementation.
   - Mark M5c implemented in the production roadmap when tests pass.
   - Add process-supervision notes to `docs/plugin-boundary.md`.
   - Add review history to this plan.

## Dependencies

- M5a descriptor validation.
- M5b registry/config projection.
- Existing `CodexRuntimeClient` and `CodexWsClient` request/notification
  handling.
- Existing `HostRuntime` lifecycle and reconnect flow.
- Existing JSON logger redaction policy.

No channel UX, OpenCandle production descriptor, Docker, Apple Container, or
network access is required for M5c unit tests.

## Validation Criteria

Required before commit:

- `bun run typecheck`
- focused plugin supervisor tests
- focused runtime-client MCP tests
- focused host lifecycle test if `HostRuntime` changes

Recommended before merge:

- `bun test`
- `bun run schema:verify` if generated MCP protocol assumptions or method
  names change

Expected result:

- the selected app-server MCP config source is explicit and covered by tests or
  manual evidence;
- app-server-managed reload/status is proven to satisfy M5c start, stop,
  restart, and failed-startup observation needs, or implementation stops before
  partial supervision lands;
- disabled/omitted plugins never reach reload input;
- enabled env-complete plugins are represented in managed MCP config;
- app-server reload/status calls are bounded and testable;
- elicitation requests decline fail-closed;
- unknown MCP server request families fail closed without raw params;
- plugin startup failure does not block normal thread routing;
- status/logs contain metadata only;
- managed config writes are state-owned, non-symlinked, atomic, and private;
- app-server parent env cannot leak channel tokens or codexclaw state paths to
  plugin children;
- no plugin command is directly spawned by codexclaw;
- no raw MCP args/output or env values are persisted.

## Risks And Mitigations

- Risk: app-server status surfaces are insufficient for process lifecycle.
  - Mitigation: make lifecycle proof a stop/go gate before supervisor-loop
    implementation.
- Risk: the selected app-server MCP config source is ambiguous.
  - Mitigation: decide and document the exact config source, files, and startup
    wiring before reload/reconcile implementation.
- Risk: app-server-managed supervision does not match the roadmap wording.
  - Mitigation: prove equivalent start/stop/restart/status semantics through
    app-server, then update roadmap and plugin-boundary docs to record that
    interpretation.
- Risk: managed config writes mutate user-owned Codex config unexpectedly.
  - Mitigation: use state-owned managed config or explicit external setup; do
    not silently mutate arbitrary global `~/.codex/config.toml`.
- Risk: plugin reconciliation delays first channel routing.
  - Mitigation: route acceptance is independent from plugin reconciliation, with
    strict startup budgets and host tests for failing plugin startup.
- Risk: reload races with active turns.
  - Mitigation: reconcile on startup/reconnect first; defer live channel
    enable/disable UX to M5d unless reload safety is verified.
- Risk: restart loops hide broken plugins.
  - Mitigation: capped backoff and terminal failed state with bounded
    diagnostics.
- Risk: env values leak through config/log/status.
  - Mitigation: env values exist only in in-memory projection/managed config;
    logs and status expose names only; tests assert absence of values.
- Risk: plugin children inherit app-server parent env.
  - Mitigation: sanitize app-server env with an allowlist or verify exact child
    env replacement before enabling M5c supervision.
- Risk: managed config writes leak env values or mutate global config through
  symlink/path mistakes.
  - Mitigation: state-owned managed path only, realpath checks, symlink refusal,
    atomic same-directory writes, `0600` file permissions, and tests.

## Review History

- 2026-05-12: Initial M5c implementation plan drafted from M5 roadmap,
  planner proposal, M5b implementation context, and MCP spike findings.
- 2026-05-12: Addressed security review findings for app-server env
  inheritance, private managed config writes, and metadata-only fail-closed
  handling for all MCP server-request families.
- 2026-05-12: Addressed implementation review findings for explicit config
  source selection, roadmap-aligned supervision semantics, lifecycle stop/go
  gates, non-blocking startup, and expected file/module ownership.
