# M5a Plugin Descriptor Security Gate Plan

## Goal

Define the minimum production descriptor schema for MCP-backed codexclaw
plugins and add a security gate that rejects unsafe descriptors before any
plugin process can be started.

M5a deliberately stops before process supervision, registry persistence, channel
commands, or OpenCandle production packaging. The output of this milestone is a
validated metadata-only plugin model that later milestones can consume.

## PRD And Roadmap References

- `docs/seed/PRD.md`
  - codexclaw remains a thin Bun + TypeScript host above `codex app-server`.
  - codexclaw stores only routing metadata, schedules, pending approval
    mappings, and prefs.
  - codexclaw does not persist conversation bodies, tool calls, diffs, approval
    histories, raw MCP arguments, or raw MCP output.
  - codexclaw does not weaken Codex sandbox or approval behavior.
- `docs/plugin-boundary.md`
- `docs/mcp-plugin-path-findings.md`
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`
- `docs/workflows.md`
- `AGENTS.md`

## Scope

In scope:

- Add a `src/plugins` module family for descriptor types, parsing, validation,
  and sanitized summaries.
- Define descriptor schema versioning.
- Require plugins to be disabled unless explicitly enabled by a later registry
  layer.
- Validate command, args, environment allowlist, network/provider metadata, and
  bounded display metadata.
- Add denylist checks for sensitive environment names and codexclaw/Codex
  state paths.
- Add tests proving unsafe descriptors are rejected with actionable diagnostics.
- Add tests proving the validated descriptor model cannot carry raw MCP
  arguments or raw MCP output.
- Add tests proving M5a does not execute plugin commands.

Out of scope:

- Reading plugin descriptors from disk.
- Persisting plugin enablement state.
- Projecting descriptors into app-server MCP config.
- Starting, stopping, or supervising plugin processes.
- Telegram, Discord, or CLI `/plugin` commands.
- MCP elicitation UX.
- OpenCandle production plugin descriptor.
- Plugin marketplace, install, update, or remote download flows.

## Product Boundary

M5a treats a plugin descriptor as configuration only. It is not executable by
itself.

Codex app-server remains responsible for MCP tool discovery and invocation once
later milestones project validated descriptors into app-server config.
codexclaw remains responsible for local validation, enablement policy,
supervision, and channel UX.

## Descriptor Shape

The planned descriptor is JSON-compatible and deliberately small:

```ts
interface PluginDescriptorV1 {
  schemaVersion: 1;
  id: string;
  displayName: string;
  version?: string;
  description?: string;
  mcp: {
    serverName: string;
    command: string;
    args?: readonly string[];
    env?: readonly PluginEnvVar[];
  };
  tools?: readonly PluginToolMetadata[];
  security: {
    network: "none" | "declared";
    providers?: readonly string[];
    envAllowlist?: readonly string[];
  };
}

interface PluginEnvVar {
  name: string;
  required?: boolean;
  description?: string;
}

interface PluginToolMetadata {
  name: string;
  title?: string;
  description?: string;
}
```

The implementation may refine field names during M5a, but the runtime boundary
must remain equivalent: descriptor identity, MCP process declaration,
environment declaration, bounded display metadata, and explicit security
metadata only.

## Validation Rules

Descriptor identity:

- `schemaVersion` must be `1`.
- `id` must be stable, lowercase, and bounded.
- `id` must not contain path separators, shell syntax, whitespace, or control
  characters.
- `displayName`, `description`, provider names, and tool metadata must be
  bounded before rendering.

MCP declaration:

- `serverName` must be stable and bounded.
- `command` must be an absolute path.
- `command` must not contain shell syntax.
- `args` must be an array of literal arguments, not a shell command string.
- `args` must not contain control characters.
- no command is executed during descriptor validation.

Environment:

- every env var passed to a plugin must be declared by name;
- env names must match a strict uppercase identifier pattern;
- sensitive env names are rejected by default, including channel bot tokens,
  app-server bearer tokens, Codex auth, codexclaw state paths, database paths,
  and broad secret/token/password/key names;
- descriptors may declare required env names, but M5a only validates metadata;
  actual process env resolution belongs to M5b/M5c.

Security metadata:

- `network` must be explicit.
- provider names are required when `network` is `declared`.
- provider names are forbidden when `network` is `none`.
- MCP elicitation remains fail-closed and is not represented as an enabled
  capability in M5a.

Storage boundary:

- validated descriptor summaries must not include MCP call arguments, MCP call
  outputs, provider response bodies, conversation content, diffs, approval
  decisions, approval histories, or raw app-server events.

## Expected Files Or Modules

New modules:

- `src/plugins/types.ts`
  - exported descriptor and validated summary types.
- `src/plugins/validation.ts`
  - descriptor parsing and validation helpers.
- `src/plugins/security.ts`
  - env name checks, sensitive-name denylist, and metadata bounding helpers.
- `src/plugins/index.ts`
  - public exports for later milestones.
- `test/plugins/plugin-descriptor.test.ts`
  - focused unit tests for M5a.

Documentation updates:

- `docs/plugin-boundary.md`
  - add a short pointer to the descriptor/security gate once implemented.
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`
  - update M5a status after implementation.

No changes are expected in:

- `src/store/pointer-store.ts`;
- channel adapters;
- runtime host startup;
- app-server helper scripts;
- MCP spike scripts.

## Ordered Tasks

1. Add descriptor and validated-summary type sketches.
   - Keep the model JSON-compatible.
   - Keep validated runtime summaries metadata-only.
   - Do not add process execution hooks.

2. Add small validation primitives.
   - `validatePluginDescriptor(input)` style API returning either a validated
     descriptor or a list of diagnostics.
   - Bounded diagnostics must identify the rejected field without echoing long
     untrusted values.
   - Parsing must fail closed for unknown schema versions.

3. Add command and args validation.
   - Require absolute command paths.
   - Reject shell metacharacter patterns in command.
   - Treat args as argv entries only.
   - Reject multiline/control-character args.

4. Add environment security gate.
   - Accept only explicitly declared env names.
   - Reject sensitive names by exact match and broad suffix/prefix patterns.
   - Include tests for Telegram, Discord, Codex auth, app-server token,
     codexclaw DB/state, and generic secret/token/password/key names.

5. Add network/provider metadata validation.
   - Require provider metadata when network is declared.
   - Reject provider metadata when network is none.
   - Bound provider strings before summaries.

6. Add sanitized summary helpers.
   - Produce display-safe plugin and tool summaries for future channel UX.
   - Do not include command args by default in channel-oriented summaries.
   - Do not include raw env values. Env values are never part of descriptors.

7. Add focused tests.
   - Valid minimal descriptor passes.
   - Disabled-by-default semantics are represented by absence of runtime
     enablement in M5a.
   - Unsafe command, args, env names, network metadata, and oversized display
     fields fail.
   - Validation does not spawn processes.
   - Summary output contains no raw MCP args/output-like fields.

8. Update docs after implementation.
   - Mark M5a as implemented in the production roadmap only after tests pass.
   - Keep implementation review notes in this plan's review history.

## Dependencies

- Existing Bun test setup.
- Existing TypeScript strict mode.
- Existing security boundary from `docs/plugin-boundary.md`.
- MCP turn-mediated validation from `docs/mcp-plugin-path-findings.md`.

No external network, OpenCandle checkout, Codex auth, Docker, Apple Container,
or running app-server is required for M5a.

## Validation Criteria

Required before commit:

- `bun run typecheck`
- `bun test test/plugins/plugin-descriptor.test.ts`

Recommended before merging into a broader plugin branch:

- `bun test`

Expected result:

- descriptor validation is deterministic and side-effect free;
- unsafe descriptors fail closed;
- diagnostics are actionable and bounded;
- no process is spawned;
- no codexclaw state schema is expanded;
- no raw MCP args/output storage path is introduced.

## Risks And Mitigations

- Risk: M5a accidentally becomes a registry or process runner.
  - Mitigation: no filesystem discovery, state writes, or process APIs in this
    milestone.
- Risk: env allowlist is too permissive and leaks channel/Codex credentials.
  - Mitigation: deny sensitive exact names and broad secret/token/password/key
    patterns by default.
- Risk: descriptors become a place to store tool schemas or raw results.
  - Mitigation: tool metadata is limited to bounded display fields only.
- Risk: command validation gives a false sense of sandboxing.
  - Mitigation: M5a only rejects obviously unsafe descriptor shapes; Codex
    sandbox and later process supervision remain separate gates.
- Risk: network/provider metadata is treated as permission.
  - Mitigation: metadata only declares behavior; explicit enablement and
    supervision arrive in later milestones.

## Review History

- 2026-05-12: Initial M5a implementation plan drafted from the M5 roadmap.
- 2026-05-12: Implemented descriptor types, validation, security helpers, and
  focused tests in `src/plugins` and `test/plugins/plugin-descriptor.test.ts`.
