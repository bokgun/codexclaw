# M5b Local Registry And Config Resolution Plan

## Goal

Load validated local MCP plugin descriptors, persist explicit plugin enablement
as codexclaw-owned domain state, and project only enabled, valid, env-complete
plugins into an app-server MCP config shape.

M5b does not start plugin processes. It creates the metadata and config
resolution layer that M5c process supervision can consume.

## PRD And Roadmap References

- `docs/seed/PRD.md`
  - codexclaw stays a thin host above `codex app-server`.
  - codexclaw stores only routing metadata, schedules, pending approval
    mappings, prefs, and codexclaw domain settings.
  - codexclaw must not persist Codex conversation bodies, tool calls, diffs,
    approval histories, raw MCP arguments, or raw MCP output.
  - codexclaw must not weaken Codex sandboxing or approval behavior.
- `docs/plugin-boundary.md`
- `docs/mcp-plugin-path-findings.md`
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`
- `docs/plans/2026-05-12-m5a-plugin-descriptor-security-gate.md`
- `docs/workflows.md`
- `AGENTS.md`

## Scope

In scope:

- Parse local plugin directory config from environment.
- Discover descriptor files from explicitly configured local directories.
- Validate discovered descriptors through the M5a descriptor security gate.
- Reject duplicate plugin ids and duplicate MCP server names deterministically.
- Persist plugin enablement as domain state in `PointerStore`.
- Resolve required env availability by name only.
- Build metadata-only registry entries for future channel UX.
- Build in-memory app-server MCP config projection for enabled plugins.
- Add tests for discovery, duplicates, enablement persistence, missing env
  diagnostics, projection, and storage boundaries.

Out of scope:

- Starting, stopping, or supervising plugin processes.
- Writing Codex config files or reloading app-server MCP config.
- Channel commands such as `/plugin list` or `/plugin enable`.
- Remote registries, downloads, installs, updates, or marketplace UX.
- Direct `mcpServer/tool/call` production UX.
- MCP elicitation UX.
- OpenCandle production plugin packaging.
- Containerized plugin execution.

## Product Boundary

M5b treats plugin descriptors as local configuration and enablement as
codexclaw domain state.

codexclaw may persist:

- plugin id;
- optional descriptor version selected by the user;
- enabled flag;
- bounded user prefs for plugin behavior in later milestones;
- timestamps.

codexclaw must not persist:

- raw MCP tool arguments;
- raw MCP tool output;
- env values;
- provider response bodies;
- Codex conversation bodies;
- Codex diffs;
- approval decisions or approval histories.

The app-server MCP config projection may contain allowlisted env values in
memory only. It must not be stored in SQLite or logs.

## Descriptor File Layout

M5b should support one explicit descriptor filename convention:

- `codexclaw-plugin.json`

Discovery behavior:

- plugin directories are configured explicitly;
- each configured directory may either contain `codexclaw-plugin.json`
  directly or contain immediate child directories with that file;
- recursive traversal beyond one child level is out of scope;
- descriptor files are read in stable sorted order;
- each descriptor file has a bounded maximum byte size;
- invalid JSON or invalid descriptors produce bounded diagnostics without
  stopping discovery of other descriptors.

## Configuration

Add plugin directory config to `src/config/env.ts`.

Sketch:

```ts
interface PluginConfig {
  pluginDirs: readonly string[];
  maxDescriptorBytes: number;
}
```

Environment:

- `CODEXCLAW_PLUGIN_DIRS`: comma-separated absolute or workspace-relative local
  directories.
- `CODEXCLAW_PLUGIN_DESCRIPTOR_MAX_BYTES`: bounded descriptor size limit.

Path policy:

- missing plugin dirs may produce diagnostics rather than process startup
  failure, so a fresh clone can run with no plugins;
- configured plugin dirs, immediate child dirs, and descriptor files must be
  checked with realpath-based path policy before reading;
- symlink escapes into denied roots must be rejected;
- directories inside codexclaw state, Codex auth/config homes, or known rollout
  storage paths must be rejected;
- workspace-local plugin dirs are acceptable because plugin descriptors are
  explicit user-owned project configuration, but they still must pass M5a
  descriptor validation and remain disabled unless explicitly enabled.

## Registry Types

Planned type sketches:

```ts
interface PluginEnablementState {
  pluginId: string;
  version?: string;
  enabled: boolean;
  updatedAt: string;
}

type LocalPluginStatus =
  | "available"
  | "invalid"
  | "duplicate"
  | "version_mismatch"
  | "missing_env";

interface LocalPluginRegistryEntry {
  id: string;
  version?: string;
  sourcePath: string;
  sourceLabel: string;
  summary?: PluginDescriptorSummary;
  descriptor?: ValidatedPluginDescriptor;
  enabled: boolean;
  status: LocalPluginStatus;
  diagnostics: readonly PluginValidationDiagnostic[];
  missingEnvNames: readonly string[];
}

interface AppServerMcpConfigProjection {
  mcpServers: readonly AppServerMcpServerConfig[];
  omitted: readonly PluginProjectionOmission[];
}

interface AppServerMcpServerConfig {
  serverName: string;
  command: string;
  args: readonly string[];
  env: readonly PluginRuntimeEnvVar[];
}

interface PluginRuntimeEnvVar {
  name: string;
  value: string;
}
```

Implementation may adjust names, but the data boundary must remain the same:
metadata-only registry entries, in-memory env values only in projection, and no
process execution.

`sourcePath` is for local diagnostics and tests. Future channel UX should render
only bounded `sourceLabel` values so absolute private paths are not exposed to
Telegram or Discord by default.

## Ordered Tasks

1. Add plugin config parsing.
   - Add `PluginConfig` and `getPluginConfig`.
   - Parse `CODEXCLAW_PLUGIN_DIRS`.
   - Bound descriptor size.
   - Reuse existing path policy helpers where possible.
   - Keep empty config valid and produce an empty registry.

2. Add descriptor discovery.
   - Add `src/plugins/registry.ts`.
   - Discover `codexclaw-plugin.json` in configured directories and immediate
     child directories only.
   - Read bounded JSON files.
   - Validate with `validatePluginDescriptor`.
   - Convert parse/read/validation failures into bounded diagnostics.

3. Add duplicate id handling.
   - Group valid descriptors by `id`.
   - If an id appears more than once, mark all entries for that id as
     `duplicate`.
   - Also group valid descriptors by `mcp.serverName`.
   - If a server name appears more than once, mark all entries for that server
     name as `duplicate`, even when plugin ids differ.
   - Duplicate ids and duplicate server names must be omitted from projection.
   - Do not try version selection in M5b.
   - Sort registry entries deterministically by id and source path.

4. Add enablement persistence.
   - Increment `PointerStore` schema version.
   - Add a `plugin_enablement` table.
   - Add methods to set/list/get enablement state.
   - Store only plugin id, optional version, enabled flag, and timestamps.
   - Add `schemaColumns("plugin_enablement")` coverage or equivalent test
     access.

5. Join registry entries with enablement state.
   - Default every discovered plugin to disabled.
   - Enablement applies only when persisted `pluginId` matches the descriptor
     id and persisted `version`, when present, matches the current descriptor
     version.
   - If persisted version is present and differs from the current descriptor
     version, mark the entry `version_mismatch` and omit it from projection
     until the user explicitly re-enables the current version in a later UX.
   - Unknown persisted plugin ids are retained in state but do not produce
     runnable config when no descriptor is present.
   - M5d can later expose stale persisted ids to users; M5b may return them as
     omitted metadata if useful.

6. Resolve env availability by name.
   - Compare required descriptor env names against a provided env map.
   - Return missing env names only.
   - Never store or log env values.
   - Optional env names may be omitted from projection when absent.

7. Project enabled plugins into app-server MCP config.
   - Omit disabled entries.
   - Omit invalid, duplicate, version-mismatched, or missing-required-env
     entries.
   - Include server name, command, argv args, and allowlisted env name/value
     pairs in memory.
   - Return omission reasons for diagnostics.
   - Keep projection shape close to the TOML config proven by the MCP spike:
     `[mcp_servers.<serverName>] command = ... args = ... env = ...`.

8. Add focused tests.
   - Empty plugin config returns empty registry/projection.
   - Valid descriptor is discovered and disabled by default.
   - Invalid JSON and invalid descriptor produce bounded diagnostics.
   - Duplicate ids are rejected deterministically.
   - Duplicate MCP server names are rejected deterministically.
   - Enablement state persists and stores no env values or payloads.
   - Persisted version mismatch does not project a plugin.
   - Missing required env names omit enabled plugins from projection.
   - Projection forwards only allowlisted env names.
   - Registry channel summaries use bounded source labels, not absolute private
     paths.
   - Disabled plugins are visible in registry and absent from projection.
   - Symlinked configured dirs, child dirs, or descriptor files cannot escape
     into state, Codex auth/config, or rollout roots.
   - No plugin command is executed.

9. Update documentation after implementation.
   - Mark M5b as implemented in the production roadmap when tests pass.
   - Add a short registry/config-resolution note to `docs/plugin-boundary.md`.
   - Add review history to this plan.

## Dependencies

- M5a descriptor validation and summary APIs.
- Existing `PointerStore` migration pattern.
- Existing config/env path policy helpers.
- Existing Bun test setup.

No Codex auth, app-server process, Docker, Apple Container, OpenCandle checkout,
or network access is required for M5b.

## Validation Criteria

Required before commit:

- `bun run typecheck`
- focused plugin registry/config tests
- focused pointer-store tests for plugin enablement persistence

Recommended before merge:

- `bun test`

Expected result:

- plugin discovery is deterministic;
- invalid descriptors do not block valid descriptors;
- duplicate ids fail closed;
- duplicate MCP server names fail closed;
- disabled plugins never appear in app-server MCP projection;
- persisted version mismatch never appears in app-server MCP projection;
- enabled plugins with missing required env are omitted with name-only
  diagnostics;
- projection contains only allowlisted env values and is never persisted;
- SQLite stores only plugin identity, optional version, enabled flag, and
  timestamps;
- no plugin command is executed.

## Risks And Mitigations

- Risk: registry work becomes process supervision.
  - Mitigation: M5b exports projection data only; M5c owns process lifecycle
    and app-server reload coordination.
- Risk: env projection leaks secrets.
  - Mitigation: only M5a allowlisted env names are eligible, missing diagnostics
    contain names only, and tests assert unlisted env values are absent.
- Risk: plugin directory discovery becomes a remote or recursive marketplace.
  - Mitigation: local explicit dirs only, one descriptor filename, one child
    directory level.
- Risk: enablement state stores too much.
  - Mitigation: dedicated table with identity/enabled/timestamps only and tests
    for persistence columns.
- Risk: duplicate version handling gets overbuilt.
  - Mitigation: reject duplicate ids and duplicate MCP server names in M5b;
    require persisted version match when a version exists; defer multi-version
    selection until a real use case exists.
- Risk: symlinked plugin paths bypass denied roots.
  - Mitigation: require realpath checks for configured dirs, immediate child
    dirs, and descriptor files, with tests for symlink escapes.

## Review History

- 2026-05-12: Initial M5b plan drafted from planner proposal and M5a
  implementation context.
- 2026-05-12: Addressed review findings for duplicate MCP server names,
  persisted version mismatch, and realpath-based symlink path checks.
