# MCP Plugin Production Roadmap

## Goal

Turn the MCP plugin path spike into a production-ready codexclaw plugin
capability without expanding codexclaw beyond its thin host boundary over
`codex app-server`.

The roadmap intentionally splits plugin work into small plan and implementation
cycles. Each cycle should be independently reviewable, testable, and reversible.

## Source References

- `docs/seed/PRD.md`
  - codexclaw stays a thin host above `codex app-server`.
  - codexclaw stores routing metadata, schedules, pending approval mappings,
    and prefs only.
  - codexclaw must not persist Codex conversation bodies, tool calls, diffs, or
    approval histories.
  - codexclaw must not weaken Codex sandboxing or approval behavior.
- `docs/plugin-boundary.md`
- `docs/mcp-plugin-path-findings.md`
- `docs/plans/2026-05-12-mcp-plugin-path-spike.md`
- `docs/plans/2026-05-12-plugin-dynamic-tool-bridge.md`
- `docs/workflows.md`
- `AGENTS.md`

## Current Evidence

The MCP spike has validated the production direction:

- direct MCP app-server diagnostic calls work;
- normal turn-mediated MCP tool use works when Codex auth is present;
- the OpenCandle-backed MCP spike can expose one provider-backed tool;
- `mcpServer/elicitation/request` can appear and must remain fail-closed until
  a deliberately designed UX exists;
- MCP tool arguments and outputs are Codex-owned data and must not be stored by
  codexclaw.

This is enough evidence to prefer MCP-backed plugins over a client-side dynamic
tool bridge for the pinned app-server version.

## Product Boundary

A production codexclaw plugin is:

- an MCP server descriptor;
- an execution command and arguments;
- an explicit environment allowlist;
- bounded tool metadata;
- security metadata for network and third-party provider use;
- an explicit user enablement setting.

Codex app-server owns MCP discovery and invocation. codexclaw owns descriptor
validation, enablement, supervision, channel UX, and metadata-only status.

codexclaw must not own raw MCP arguments, raw MCP output, Codex conversation
content, Codex diffs, or approval histories.

## Milestones

### M5a - Descriptor Schema And Security Gate

Status: implemented.

Goal: define the smallest stable plugin descriptor and reject unsafe plugin
configuration before any process is started.

Scope:

- descriptor schema and TypeScript types;
- default disabled plugin state;
- command and args validation;
- environment allowlist validation;
- network/provider metadata validation;
- bounded display metadata;
- tests proving disabled plugins do not run;
- tests proving unsafe env names and implicit secrets are rejected;
- tests proving raw MCP args/output are not part of codexclaw state models.

Non-goals:

- plugin process supervision;
- Telegram or Discord plugin commands;
- OpenCandle production packaging;
- marketplace or remote plugin installation.

Exit criteria:

- invalid descriptors fail with actionable diagnostics;
- valid descriptors can be parsed into metadata-only runtime records;
- no plugin command is executed by this milestone;
- `bun run typecheck` and focused tests pass.

Implemented in:

- `src/plugins/types.ts`;
- `src/plugins/security.ts`;
- `src/plugins/validation.ts`;
- `test/plugins/plugin-descriptor.test.ts`.

### M5b - Local Registry And Config Resolution

Goal: load explicitly enabled local plugin descriptors and resolve the app-server
MCP config that codexclaw may pass to a supervised app-server session.

Scope:

- local plugin descriptor discovery from configured directories;
- enabled/disabled state storage using codexclaw domain data only;
- deterministic descriptor id and version handling;
- duplicate id rejection;
- missing env diagnostics;
- app-server MCP config projection from validated descriptors;
- tests for state persistence boundaries.

Non-goals:

- long-running MCP process supervision;
- channel commands that mutate plugin state;
- remote registry or plugin downloads.

Exit criteria:

- enabled plugins produce an app-server MCP config projection;
- disabled plugins are visible as metadata but omitted from runtime config;
- codexclaw state stores only descriptor identity, enablement, and prefs;
- no raw tool call data is persisted.

Implemented in:

- `src/config/env.ts`;
- `src/plugins/registry.ts`;
- `src/plugins/types.ts`;
- `src/store/pointer-store.ts`;
- `test/config/env.test.ts`;
- `test/plugins/plugin-registry.test.ts`;
- `test/store/pointer-store.test.ts`.

### M5c - Process Supervision

Goal: supervise local MCP plugin server processes with clear lifecycle and
bounded diagnostics.

Status: implemented as app-server-managed supervision. codexclaw projects
validated enabled plugins into a private managed app-server MCP config, requests
app-server reload/status, observes metadata-only lifecycle events, and keeps
core channel routing non-blocking when plugin startup fails or stalls. The
managed app-server `CODEX_HOME` must be authenticated explicitly; codexclaw does
not copy Codex auth from a user's global home.

Scope:

- start/stop lifecycle for enabled local plugin MCP servers;
- restart/backoff policy;
- health/status state;
- bounded stdout/stderr summaries with redaction;
- app-server reload coordination;
- clean shutdown on host exit;
- tests for crash, startup timeout, disabled plugin, and redacted logs.

Non-goals:

- containerized third-party execution;
- remote plugin runtime;
- channel-specific UX beyond generic status data.

Exit criteria:

- codexclaw can start, stop, and restart a local MCP plugin server through
  app-server MCP reload/status coordination;
- supervision status contains no secrets or raw tool payloads;
- failed plugin startup does not prevent core channel routing;
- app-server reload only sees validated enabled descriptors.

Implemented in:

- `src/codex/runtime-client.ts`;
- `src/plugins/supervisor.ts`;
- `src/runtime/host.ts`;
- `src/config/env.ts`;
- `scripts/start-codex-app-server.sh`;
- `test/codex/runtime-client.test.ts`;
- `test/plugins/plugin-supervisor.test.ts`;
- `test/runtime/host.test.ts`;
- `test/config/env.test.ts`.

### M5d - Channel UX

Status: implemented.

Goal: expose plugin inspection and enablement through personal channel UX
without hiding security-relevant facts from the user.

Scope:

- CLI, Telegram, and Discord plugin commands where applicable:
  - `/plugin list`;
  - `/plugin status <id>`;
  - `/plugin enable <id>`;
  - `/plugin disable <id>`;
- network/provider warning text;
- missing env guidance;
- bounded tool metadata rendering;
- interaction flow for explicit enablement;
- tests for channel command routing and authorization.

Non-goals:

- generic plugin marketplace;
- automatic plugin enablement;
- MCP elicitation UX.

Exit criteria:

- users can inspect plugins before enabling them;
- enablement is explicit and auditable through codexclaw domain state;
- network/provider use is visible before enablement;
- channel responses do not include raw MCP arguments or outputs.

Implemented in:

- `src/channel/commands.ts`;
- `src/channel/types.ts`;
- `src/plugins/commands.ts`;
- `src/runtime/router.ts`;
- `src/runtime/host.ts`;
- `test/channel/commands.test.ts`;
- `test/plugins/plugin-commands.test.ts`;
- `test/runtime/router.test.ts`;
- `test/runtime/host.test.ts`.

### M5e - OpenCandle Production Plugin Slice

Goal: convert the OpenCandle spike into the first production-style local MCP
plugin using the descriptor, registry, supervision, and channel UX built in
M5a-M5d.

Scope:

- local OpenCandle plugin descriptor;
- one initial tool, likely `get_fear_greed`;
- provider/network metadata;
- env allowlist;
- bounded output rendering;
- manual checklist for authenticated turn-mediated use;
- documentation for local setup.

Non-goals:

- full OpenCandle tool surface;
- financial advice workflows;
- remote hosted provider execution;
- plugin marketplace distribution.

Exit criteria:

- OpenCandle can be enabled explicitly as a local MCP plugin;
- Codex can call the tool during a normal turn;
- codexclaw logs and state remain metadata-only;
- failure modes produce actionable user-facing status.

### M5f - Hardening And Release Documentation

Goal: make plugin operation supportable for a fresh clone user.

Scope:

- README plugin section;
- plugin boundary documentation update;
- manual checklist;
- container deployment notes for plugin execution;
- troubleshooting for auth, env, network, provider, and app-server MCP reload;
- security checklist.

Exit criteria:

- a fresh clone user can enable the sample plugin using documented steps;
- plugin security boundaries are clear in docs;
- M5 can be marked complete in `docs/ROADMAP.md`.

## Implementation Order

1. M5a descriptor schema and security gate.
2. M5b local registry and config resolution.
3. M5c process supervision.
4. M5d channel UX.
5. M5e OpenCandle production plugin slice.
6. M5f docs and release checklist.

Do not implement M5b before M5a is reviewed. Do not implement M5c before the
registry can prove disabled plugins are omitted from runtime config. Do not
implement channel enablement before network/provider warnings and missing env
diagnostics exist.

## Validation Strategy

Every milestone should run:

- `bun run typecheck`;
- focused Bun tests for changed modules;
- `bun test` before commit when the touched surface is broad;
- schema gate when app-server protocol assumptions are touched.

Manual validation is required before marking M5e complete:

- start codexclaw with the plugin disabled and confirm no plugin process starts;
- enable the plugin explicitly;
- confirm status shows network/provider metadata;
- run an authenticated turn-mediated tool call;
- confirm codexclaw state and logs do not contain raw MCP args or output.

## Risks And Controls

- Scope creep into a plugin marketplace.
  - Control: local descriptor first; no download/install UX in M5.
- Accidental secret forwarding to plugin processes.
  - Control: env allowlist with denylisted sensitive defaults and tests.
- Raw MCP payload persistence.
  - Control: state model tests and bounded status summaries only.
- Confusing Codex native plugins with codexclaw plugins.
  - Control: docs and UX label these as local MCP plugins managed by codexclaw.
- MCP elicitation exposing an unreviewed request path.
  - Control: fail-closed until a separate plan designs response shape and UX.
- Provider/network behavior surprising the user.
  - Control: descriptor metadata and explicit warnings before enablement.

## Review History

- 2026-05-12: Initial roadmap drafted from MCP spike findings and plugin
  boundary policy.
