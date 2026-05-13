# CodexClaw Plugin Boundary

Status: draft policy for MCP-backed local plugins.

Date: 2026-05-12

## Minimal Plugin Unit

A codexclaw plugin is not a Codex patch and not an in-process extension. The
minimum supported unit is:

- MCP server descriptor;
- execution command and arguments;
- explicit environment allowlist;
- tool metadata exposed by that MCP server;
- security metadata describing whether network or external providers are used.

The plugin descriptor is configuration. Tool discovery and invocation remain
owned by Codex app-server through MCP.

## Ownership Split

Codex app-server owns:

- MCP server discovery from configured descriptors;
- MCP tool enumeration;
- MCP tool invocation during Codex turns, if supported by the pinned app-server;
- Codex sandboxing, approval, model routing, rollout storage, and thread items.

codexclaw owns:

- plugin enablement settings;
- process supervision for local MCP servers;
- channel UX for status, errors, and user-facing enablement;
- policy checks before a plugin descriptor is made available to app-server;
- metadata-only logs for plugin lifecycle and bounded status summaries.

codexclaw does not own:

- raw MCP tool arguments;
- raw MCP tool output;
- Codex conversation bodies;
- Codex diffs or patches;
- approval histories;
- model/tool routing inside Codex.

## Security Gate

All codexclaw plugins are disabled by default. A plugin must be explicitly
enabled before codexclaw configures or supervises its MCP server.

Minimum enablement policy:

- `enabled` must be explicit and default to `false`;
- plugin command and args must be explicit, absolute, and reviewed;
- environment variables passed to the plugin must be allowlisted by name;
- channel bot tokens, app-server bearer tokens, codexclaw SQLite paths, and
  Codex auth files are not passed to plugins by default;
- raw MCP arguments and outputs are not persisted in codexclaw state or logs;
- MCP elicitation is fail-closed unless a verified response shape and channel UX
  are deliberately implemented;
- plugins must declare whether they use network access or third-party API
  providers;
- plugin-provided descriptions and schemas are treated as untrusted display
  data and must be bounded before channel rendering.

The M5a descriptor security gate is implemented in `src/plugins`. It validates
descriptor shape, command paths, argv entries, env declarations, sensitive env
names, network/provider metadata, and bounded display summaries without reading
plugin descriptors from disk, storing enablement state, or starting plugin
processes.

M5b adds local registry and config resolution. codexclaw discovers only
explicit local `codexclaw-plugin.json` files from configured plugin
directories, keeps plugins disabled by default, stores enablement as descriptor
identity plus timestamps, and builds an in-memory app-server MCP config
projection for enabled descriptors whose required env names are present. Env
values are projected only from allowlisted names and are not written to SQLite.

M5c adds app-server-managed process supervision. codexclaw writes a
state-owned managed `CODEX_HOME/config.toml` containing only validated enabled
MCP server entries, asks app-server to reload MCP config, observes reload/status
and startup-status metadata, and keeps channel routing independent from plugin
failures. codexclaw still does not fork plugin commands directly, persist raw
MCP arguments or outputs, or make Codex sandbox/approval decisions.

Managed MCP config is private host state. It is written atomically under the
codexclaw state directory with private permissions, rejects symlink escapes, and
contains only descriptor command/args plus allowlisted env values required by
app-server. Runtime status exposes plugin id, server name, desired/observed
state, restart count, missing env names, and bounded error summaries only.
The managed `CODEX_HOME` must be authenticated explicitly with
`codex login --device-auth`; codexclaw does not copy Codex auth from a user's
global home into the managed plugin-supervision home.

M5d adds channel UX for `/plugin list`, `/plugin status <id>`,
`/plugin enable <id>`, `/plugin enable <id> --confirm`, and
`/plugin disable <id>`. The UX is channel-neutral text routed through the
existing CLI, Telegram, and Discord command path after adapter authorization has
already accepted the inbound message. Enablement is a two-step flow: the first
enable command renders descriptor status, network/provider metadata, env names,
missing env names, tool summaries, and fail-closed elicitation policy without
mutating state; the `--confirm` form persists only plugin id, version, enabled
flag, and timestamps in codexclaw domain state. Channel responses render env
names only and do not render env values, raw MCP command args, raw MCP tool
arguments, raw MCP outputs, conversation bodies, diffs, or approval history.
After enable/disable, codexclaw requests supervisor reconciliation when
available, but app-server remains responsible for MCP discovery and invocation.

## OpenCandle Production Slice

M5e adds OpenCandle as the first production-style local MCP plugin slice:

- the checked-in descriptor source is
  `plugins/opencandle/codexclaw-plugin.template.json`;
- `bun run plugin:materialize:opencandle` writes a local
  `local-plugins/opencandle/codexclaw-plugin.json` with absolute Bun and server
  paths;
- the MCP server entrypoint is `plugins/opencandle/server.ts`;
- it exposes one tool, `get_fear_greed`;
- it uses OpenCandle provider code from an absolute local checkout path named by
  `OPENCANDLE_ROOT`;
- it requires network access to the provider used by OpenCandle;
- it declares providers `OpenCandle` and `alternative.me`;
- it allowlists only `OPENCANDLE_ROOT`;
- it rejects missing `OPENCANDLE_ROOT` without falling back to a
  developer-specific local path;
- it does not persist provider responses in codexclaw;
- fixture tests cover bounded MCP content and structured content without live
  network access.

The OpenCandle slice remains intentionally narrow. It does not add financial
advice workflows, the full OpenCandle tool surface, a marketplace, remote
provider execution, or MCP elicitation UX. Authenticated turn-mediated tool use
is tracked in `docs/M5-plugin-manual-checklist.md` before M5 is marked complete.
