# M5e OpenCandle Production Plugin Slice Plan

## Goal

Convert the existing OpenCandle MCP spike into the first production-style local
codexclaw plugin using the M5a-M5d descriptor, registry, app-server-managed
supervision, and channel UX.

M5e should prove that a real provider-backed local MCP server can be packaged,
enabled, surfaced to Codex during a normal turn, and operated without expanding
codexclaw into a tool execution host.

## Roadmap References

- `docs/seed/PRD.md` thin-host constraint: codexclaw must not persist Codex
  rollout bodies, raw tool payloads, diffs, or approval histories.
- `docs/ROADMAP.md` M5 MCP-backed local plugins.
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md` M5e milestone.
- `docs/plugin-boundary.md` plugin ownership and security boundary.
- `docs/mcp-plugin-path-findings.md` OpenCandle spike findings.
- M5a-M5d plans and implementations:
  - descriptor validation and display sanitization;
  - local registry and config projection;
  - app-server-managed MCP supervision;
  - `/plugin` channel UX.

## Scope

- Add a local OpenCandle plugin package inside this repository.
- Provide one initial MCP tool: `get_fear_greed`.
- Add a production descriptor with:
  - explicit plugin id and version;
  - explicit MCP server name;
  - explicit command and args that satisfy the existing absolute-command
    descriptor gate;
  - `OPENCANDLE_ROOT` env allowlist;
  - network/provider metadata for OpenCandle and its upstream provider.
- Add a local setup or descriptor materialization path if a checked-in
  descriptor cannot safely contain the final absolute Bun command path.
- Move or wrap the spike MCP server into the production plugin location without
  broadening the tool surface.
- Keep MCP tool input and output bounded.
- Add tests proving descriptor discovery, enablement projection, and channel
  status for the OpenCandle plugin.
- Add a manual checklist for authenticated turn-mediated OpenCandle validation.
- Update M5 roadmap and plugin-boundary docs only for M5e status and boundary
  changes.

## Non-Goals

- Full OpenCandle tool surface.
- Financial advice, recommendations, portfolio analysis, or trading workflows.
- Remote hosted provider execution.
- Plugin marketplace, plugin installation, or plugin download UX.
- In-process OpenCandle SDK dependency bundled into codexclaw.
- Persisting provider responses, MCP arguments, MCP outputs, conversation
  bodies, diffs, or approval histories.
- Bypassing Codex sandbox, approval, model routing, or MCP invocation behavior.

## Dependencies

- M5a descriptor validation must remain the only descriptor admission path.
- M5b registry discovery must be able to discover the production descriptor from
  configured local plugin directories.
- M5c supervision must project enabled plugin descriptors into managed
  app-server MCP config without codexclaw directly spawning plugin commands.
- M5d `/plugin` commands must expose status and enablement without rendering
  env values, raw command args, or raw MCP payloads.
- A local OpenCandle checkout is required only for manual validation and
  provider-backed runtime use.
- Network access is required only when the MCP tool is actually called.

## Expected Files And Modules

- `plugins/opencandle/codexclaw-plugin.json`
- `plugins/opencandle/server.ts` or a small wrapper around the existing spike
  server
- Optional non-discoverable descriptor template, for example
  `plugins/opencandle/codexclaw-plugin.template.json`, if the final descriptor
  needs a local absolute command path generated at setup time
- Optional setup/materialization helper that writes the generated descriptor to a
  user-owned local plugin directory such as
  `.codexclaw/plugins/opencandle/codexclaw-plugin.json`
- `src/spike/opencandle-mcp-server.ts`
- `src/spike/mcp-plugin-path-probe.ts`
- `test/plugins/opencandle-plugin.test.ts`
- Existing focused plugin tests when shared behavior changes:
  - `test/plugins/plugin-descriptor.test.ts`
  - `test/plugins/plugin-registry.test.ts`
  - `test/plugins/plugin-commands.test.ts`
  - `test/plugins/plugin-supervisor.test.ts`
- `docs/M5-plugin-manual-checklist.md`
- `docs/plugin-boundary.md`
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`
- `docs/ROADMAP.md`

## Descriptor Shape Sketch

The production descriptor should stay within the M5a schema:

```ts
interface OpenCandlePluginDescriptorSketch {
  schemaVersion: 1;
  id: "opencandle";
  displayName: "OpenCandle";
  version: string;
  description: string;
  mcp: {
    serverName: "opencandle";
    command: string;
    args: readonly string[];
    env: readonly [{ name: "OPENCANDLE_ROOT"; required: true; description: string }];
  };
  tools: readonly [
    {
      name: "get_fear_greed";
      title: string;
      description: string;
    }
  ];
  security: {
    network: "declared";
    providers: readonly string[];
    envAllowlist: readonly ["OPENCANDLE_ROOT"];
  };
}
```

If a checked-in `plugins/opencandle/codexclaw-plugin.json` exists, it must be a
valid discoverable descriptor under the M5b discovery rules. If portability
requires materialization, the checked-in source must use a non-discoverable name
such as `codexclaw-plugin.template.json`, and the setup step must write the
generated descriptor to a user-owned local plugin directory. Fresh-clone docs
must tell users to put that generated directory, not the template path, in
`CODEXCLAW_PLUGIN_DIRS`.

The source descriptor or template must not include env values, secrets,
user-specific absolute paths, or provider responses. If the existing M5a
absolute-command gate requires an absolute Bun path, implementation should
materialize a local descriptor from the template or introduce a small setup step
that writes only command path metadata into user-owned local plugin
configuration.

## MCP Server Contract Sketch

The production OpenCandle MCP server should expose the same narrow surface as
the spike:

```ts
interface GetFearGreedToolContract {
  name: "get_fear_greed";
  inputSchema: {
    type: "object";
    properties: {};
    additionalProperties: false;
  };
  outputSummary: {
    value: number;
    label: string;
    provider: "opencandle";
    source: string;
  };
}
```

Implementation may reuse spike logic, but the production path should be the one
referenced by the descriptor and manual validation checklist. The production
server or wrapper must not keep the spike-only fallback to
`/Users/bokgun/Workspace/OpenCandle`; missing `OPENCANDLE_ROOT` must fail with a
bounded actionable error before attempting provider import.

## Ordered Tasks

1. Inspect the current spike server and probe assumptions.
   - Identify which parts are reusable for production packaging.
   - Confirm `OPENCANDLE_ROOT` is the only OpenCandle-specific runtime input.
   - Confirm no provider response is currently persisted by codexclaw.

2. Add the production OpenCandle plugin package.
   - Choose exactly one descriptor strategy:
     - a checked-in valid `codexclaw-plugin.json` if command validation can be
       satisfied portably; or
     - a checked-in non-discoverable template plus a setup/materialization step
       that writes `.codexclaw/plugins/opencandle/codexclaw-plugin.json`.
   - Place the MCP server entrypoint next to the descriptor or add a small
     wrapper that delegates to the existing server module.
   - Ensure the descriptor command and args are explicit and compatible with the
     descriptor security gate.
   - Do not weaken `mcp.command` validation to make repository-relative paths
     work.
   - Require `OPENCANDLE_ROOT` in the production server path and remove any
     user-specific fallback path from production behavior.

3. Keep the spike path usable but clearly separate.
   - Either update the spike probe to target the production plugin server or
     document why the spike still points at the old path.
   - Avoid two conflicting descriptors or duplicate MCP server names in the
     default registry path.

4. Add focused tests.
   - Production descriptor validates through M5a.
   - Descriptor materialization, if needed, writes only local command path
     metadata and never env values.
   - The source template, if used, is not discoverable by M5b until materialized
     into a generated `codexclaw-plugin.json`.
   - Registry discovery finds the OpenCandle descriptor when the plugin
     directory is configured.
   - Disabled OpenCandle is omitted from app-server MCP projection.
   - Enabled OpenCandle with missing `OPENCANDLE_ROOT` is omitted with
     `missing_env`.
   - Enabled OpenCandle with `OPENCANDLE_ROOT` projects only the allowlisted env
     name.
   - Production server behavior rejects missing `OPENCANDLE_ROOT` with a bounded
     actionable error and no user-specific fallback.
   - `/plugin status opencandle` renders provider/network metadata and env names
     without env values or raw MCP command args.

5. Add a manual validation checklist.
   - Start from a clean or documented state directory.
   - Start app-server with plugin supervision enabled.
   - Confirm disabled OpenCandle does not appear in managed MCP config.
   - Enable OpenCandle with `/plugin enable opencandle --confirm`.
   - Confirm status shows network/provider metadata and no env values.
   - Run an authenticated turn that asks Codex to call `get_fear_greed`.
   - Confirm tool discovery and invocation happen inside the Codex turn.
   - Confirm codexclaw state and logs remain metadata-only.

6. Update docs and roadmap status.
   - Replace the OpenCandle spike boundary text with production-slice status
     while preserving the distinction between spike and production paths.
   - Mark M5e implemented only after automated tests pass and manual validation
     is recorded or explicitly left unchecked with a reason.

## Important Control Flow Pseudocode

Descriptor discovery should continue to use existing M5b flow:

```text
configured plugin dirs
  -> find codexclaw-plugin.json
  -> validate through M5a gate
  -> join with PointerStore enablement
  -> project enabled descriptor to app-server MCP config
```

Manual turn-mediated validation should verify the real production path:

```text
start app-server with managed CODEX_HOME
start a channel or CLI session
send /plugin enable opencandle
send /plugin enable opencandle --confirm
ask Codex to use get_fear_greed during a normal turn
inspect channel output, plugin status, app-server logs, and codexclaw state
```

## Validation Criteria

- `bun run typecheck` passes.
- Focused plugin tests pass.
- `bun test` passes before commit because this touches registry, supervisor,
  channel UX, and docs.
- The production OpenCandle descriptor validates through the same path as other
  local descriptors.
- If descriptor materialization is added, the checked-in template remains
  portable, non-discoverable by default, and the materialized descriptor remains
  local-only in the documented plugin directory.
- Missing `OPENCANDLE_ROOT` fails through the registry/status preflight and the
  production server path; no production path falls back to a developer-specific
  filesystem location.
- Disabled OpenCandle never appears in projected app-server MCP config.
- Missing `OPENCANDLE_ROOT` is actionable in `/plugin status`.
- Env values and provider payloads are absent from codexclaw state, logs, and
  channel status output.
- Manual checklist records whether authenticated turn-mediated invocation was
  completed, skipped, or blocked.

## Risks And Unknowns

- The descriptor security gate may reject repository-relative command paths.
  Resolve by choosing an explicit command/args strategy that fits existing
  validation instead of weakening the gate.
- The production plugin may still depend on a sibling OpenCandle checkout.
  Keep that dependency explicit through `OPENCANDLE_ROOT` and docs rather than
  silently assuming a local path.
- Provider/network failures may be confused with plugin supervision failures.
  Keep user-facing status explicit about missing env, network/provider use, and
  app-server MCP status.
- Duplicating the spike and production server paths can create drift. Prefer a
  single shared MCP server implementation with separate spike/prod entrypoints
  only if needed.
- Turn-mediated MCP use depends on current Codex app-server behavior and
  authentication. Manual validation must record exact commands and outcome.

## Review History

- 2026-05-14: Initial M5e plan drafted from the M5 roadmap, plugin boundary,
  OpenCandle spike findings, and M5a-M5d implementation state.
