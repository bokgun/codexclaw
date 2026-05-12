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

## OpenCandle Spike Boundary

The OpenCandle MCP spike is intentionally narrower than a production plugin:

- it exposes one tool, `get_fear_greed`;
- it uses OpenCandle provider code from a local checkout;
- it requires network access to the provider used by OpenCandle;
- it does not introduce a plugin registry;
- it does not persist provider responses in codexclaw;
- it is valid only as an integration-cost measurement.

Production OpenCandle support still requires an explicit plugin descriptor,
enablement UX, provider credential policy, process supervision, and tests around
bounded output handling.
