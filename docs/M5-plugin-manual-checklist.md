# M5 Plugin Manual Checklist

Status: M5e automated implementation checks recorded; authenticated
turn-mediated OpenCandle validation still requires a local Codex login,
OpenCandle checkout, and network access.

Date started: 2026-05-14

## Environment

- [ ] Record host mode: local, Docker, or Apple Container.
- [ ] Record Codex CLI version.
- [ ] Record Bun version.
- [ ] Confirm the managed plugin `CODEX_HOME` is authenticated with
  `codex login --device-auth`.
- [ ] Confirm `OPENCANDLE_ROOT` points to a local OpenCandle checkout.
- [ ] Confirm network access to the OpenCandle upstream provider is available.

## Automated Checks

- [x] Production descriptor template exists at
  `plugins/opencandle/codexclaw-plugin.template.json`.
- [x] Generated descriptor command and server arg are explicit absolute paths.
- [x] Checked-in OpenCandle descriptor source is a non-discoverable template.
- [x] `bun run plugin:materialize:opencandle` generates a local descriptor with
  absolute Bun and server paths.
- [x] Descriptor does not contain env values, provider responses, or
  user-specific filesystem paths.
- [x] OpenCandle plugin declares one tool: `get_fear_greed`.
- [x] OpenCandle plugin declares network/provider metadata for OpenCandle and
  `alternative.me`.
- [x] OpenCandle plugin allowlists only `OPENCANDLE_ROOT`.
- [x] Disabled OpenCandle is omitted from app-server MCP projection.
- [x] Enabled OpenCandle with missing `OPENCANDLE_ROOT` reports `missing_env`.
- [x] Enabled OpenCandle with `OPENCANDLE_ROOT` projects only the allowlisted env
  name.
- [x] `/plugin status opencandle` renders provider and env names without env
  values or raw MCP command args.
- [x] Fixture MCP call returns bounded content and structured content without a
  live network call.
- [x] Production provider path rejects missing `OPENCANDLE_ROOT` without falling
  back to a developer-specific path.

Automated evidence:

- `bun test test/plugins/opencandle-plugin.test.ts`: passed on 2026-05-14.
- `bun run typecheck`: passed on 2026-05-14.

## Manual Validation

1. Configure plugin discovery.

   ```sh
   bun run plugin:materialize:opencandle
   export CODEXCLAW_PLUGIN_DIRS=local-plugins
   export CODEXCLAW_PLUGIN_SUPERVISION_ENABLED=true
   export OPENCANDLE_ROOT=/absolute/path/to/OpenCandle
   ```

2. Start app-server and a channel or CLI adapter.

   ```sh
   bun run start:codex
   bun run cli
   ```

3. Confirm disabled default.

   - [ ] Run `/plugin list`.
   - [ ] Confirm `opencandle` is visible and disabled.
   - [ ] Confirm no OpenCandle MCP server is projected before enablement.

4. Inspect status before enablement.

   - [ ] Run `/plugin status opencandle`.
   - [ ] Confirm provider metadata is visible.
   - [ ] Confirm `OPENCANDLE_ROOT` appears by name only.
   - [ ] Confirm the actual `OPENCANDLE_ROOT` value is not rendered.

5. Enable explicitly.

   - [ ] Run `/plugin enable opencandle`.
   - [ ] Confirm the preview does not mutate enablement.
   - [ ] Run `/plugin enable opencandle --confirm`.
   - [ ] Confirm status transitions to enabled or reports actionable missing env.

6. Validate turn-mediated tool use.

   - [ ] Ask Codex in a normal turn to use the `get_fear_greed` MCP tool from
     server `opencandle`.
   - [ ] Confirm Codex discovers and invokes the MCP tool during the turn.
   - [ ] Confirm the response reports only the index value/classification or a
     bounded failure.

7. Inspect metadata-only boundary.

   - [ ] Confirm codexclaw SQLite state does not contain raw MCP arguments, raw
     MCP output, provider response bodies, conversation bodies, diffs, or
     approval history.
   - [ ] Confirm codexclaw logs do not contain env values or provider response
     bodies.

## Notes

- Do not mark M5 complete until the manual validation section is completed or
  each skipped item has a dated reason.
