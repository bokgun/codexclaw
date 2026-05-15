# M5 Plugin Manual Checklist

Status: M5e automated implementation checks recorded; authenticated isolated
OpenCandle MCP probe passed. Full channel-level `/plugin` validation remains
the release gate for marking M5 complete.

Date started: 2026-05-14

## Environment

- [ ] Record host mode: local, Docker, or Apple Container.
- [ ] Record Codex CLI version.
- [ ] Record Bun version.
- [ ] If Docker is used, record `docker compose version` and the final
  `scripts/docker-compose-codex.sh` command set.
- [ ] If Apple Container is used, record `container --version` and the final
  `scripts/apple-container-codex.sh` command set.
- [ ] Confirm the managed plugin `CODEX_HOME` is authenticated with
  `codex login --device-auth`.
- [ ] Confirm `OPENCANDLE_ROOT` points to a local OpenCandle checkout.
- [ ] Run `npm run build` in `OPENCANDLE_ROOT`.
- [ ] Confirm network access to the OpenCandle upstream provider is available.
- [ ] Confirm `CODEXCLAW_PLUGIN_DIRS=local-plugins`.
- [ ] Confirm `CODEXCLAW_PLUGIN_SUPERVISION_ENABLED=true`.
- [ ] Confirm `local-plugins/opencandle/codexclaw-plugin.json` is generated
  locally and not committed.
- [ ] If a descriptor was regenerated after earlier enablement, confirm
  `/plugin status opencandle` does not report stale enablement before retrying.

## Automated Checks

- [x] Production descriptor template exists at
  `plugins/opencandle/codexclaw-plugin.template.json`.
- [x] Generated descriptor command and server arg are explicit absolute paths.
- [x] Checked-in OpenCandle descriptor source is a non-discoverable template.
- [x] `bun run plugin:materialize:opencandle` generates a local descriptor with
  absolute Bun and server paths.
- [x] Checked-in descriptor template does not contain env values, provider
  responses, or user-specific filesystem paths. The generated local descriptor
  intentionally contains machine-local absolute Bun and server paths and remains
  uncommitted.
- [x] OpenCandle plugin declares the OpenCandle MCP adapter tools:
  `get_stock_quote`, `search_ticker`, and `get_fear_greed`.
- [x] OpenCandle plugin declares network/provider metadata for OpenCandle,
  Yahoo Finance, and Alternative.me.
- [x] OpenCandle plugin allowlists only `OPENCANDLE_ROOT`.
- [x] Disabled OpenCandle is omitted from app-server MCP projection.
- [x] Enabled OpenCandle with missing `OPENCANDLE_ROOT` reports `missing_env`.
- [x] Enabled OpenCandle with `OPENCANDLE_ROOT` projects only the allowlisted env
  name.
- [x] `/plugin status opencandle` renders provider and env names without env
  values or raw MCP command args.
- [x] Fixture adapter module loads without a live network call.
- [x] Production adapter path rejects missing, relative, or unbuilt
  `OPENCANDLE_ROOT` without falling back to a developer-specific path.

Automated evidence:

- `bun test test/plugins/opencandle-plugin.test.ts`: passed on 2026-05-14.
- `bun run typecheck`: passed on 2026-05-14.
- `bun test`: passed on 2026-05-14.
- `bun run schema:verify`: passed on 2026-05-14.

Probe evidence:

- `OPENCANDLE_ROOT=/absolute/path/to/OpenCandle bun run spike:opencandle-mcp`:
  passed on 2026-05-14. The `opencandle` MCP server was discovered and the
  status listed `get_stock_quote`, `search_ticker`, and `get_fear_greed`; the
  direct diagnostic `get_stock_quote` call succeeded.
- `OPENCANDLE_ROOT=/absolute/path/to/OpenCandle CODEXCLAW_MCP_PROBE_COPY_AUTH=1
  CODEXCLAW_MCP_PROBE_TURN=1 bun run spike:opencandle-mcp`: passed on
  2026-05-14. The probe copied only `auth.json` into a temporary `CODEX_HOME`,
  completed a normal turn using `get_stock_quote`, observed two MCP events, and
  declined MCP elicitation fail-closed. This auth copy is diagnostic-only
  evidence from an isolated probe; normal setup should authenticate the managed
  Codex home with `codex login --device-auth`.

## Manual Validation

1. Configure plugin discovery.

   ```sh
   bun run plugin:materialize:opencandle
   export CODEXCLAW_PLUGIN_DIRS=local-plugins
   export CODEXCLAW_PLUGIN_SUPERVISION_ENABLED=true
   export OPENCANDLE_ROOT=/absolute/path/to/OpenCandle
   cd "$OPENCANDLE_ROOT" && npm run build
   ```

   Container path notes:

   - For host codexclaw plus containerized app-server, the base Docker and
     Apple Container recipes do not by themselves enable OpenCandle plugin
     execution. Plugin-capable container validation also requires the managed
     Codex home/config, generated descriptor command, Bun runtime, codexclaw
     checkout, and OpenCandle checkout to be visible inside the app-server
     runtime.
   - Mount codexclaw, OpenCandle, and generated descriptor inputs read-only
     unless they are intentionally the Codex-editable workspace for that smoke.
     Do not mount a host global `CODEX_HOME` or the whole codexclaw state
     directory.
   - `OPENCANDLE_ROOT` must be meaningful to the app-server runtime that starts
     MCP servers. Mount the OpenCandle checkout at the same absolute path or set
     `OPENCANDLE_ROOT` to the container-visible path and materialize/test with
     that layout.
   - Do not put OpenCandle credentials, channel bot tokens, app-server bearer
     tokens, or Codex auth files in the plugin descriptor.
   - Authenticate the managed Codex home used by app-server/plugin supervision
     separately with `codex login --device-auth`.

2. Start app-server and a channel or CLI adapter.

   ```sh
   bun run start:codex
   bun run cli
   ```

3. Confirm disabled default.

   - [ ] Run `/plugin list`.
   - [ ] Confirm `opencandle` is visible and disabled.
   - [ ] Confirm duplicate plugin ids or duplicate MCP server names are reported
     as non-enableable if a duplicate descriptor is intentionally introduced in
     a disposable plugin directory.
   - [ ] Confirm no OpenCandle MCP server is projected before enablement.

4. Inspect status before enablement.

   - [ ] Run `/plugin status opencandle`.
   - [ ] Confirm provider metadata is visible.
   - [ ] Confirm `OPENCANDLE_ROOT` appears by name only.
   - [ ] Confirm the actual `OPENCANDLE_ROOT` value is not rendered.
   - [ ] Confirm stale enablement is reported if the descriptor identity changed
     after a previous enablement.

5. Enable explicitly.

   - [ ] Run `/plugin enable opencandle`.
   - [ ] Confirm the preview does not mutate enablement.
   - [ ] Run `/plugin enable opencandle --confirm`.
   - [ ] Confirm status transitions to enabled or reports actionable missing env.

6. Validate turn-mediated tool use.

   - [ ] Ask Codex in a normal turn to use the `get_stock_quote` MCP tool from
     server `opencandle`.
   - [ ] Confirm Codex discovers and invokes the MCP tool during the turn.
   - [ ] Confirm the response reports only bounded quote metadata or a bounded
     failure.

7. Inspect metadata-only boundary.

   - [ ] Confirm codexclaw SQLite state does not contain raw MCP arguments, raw
     MCP output, provider response bodies, conversation bodies, diffs, or
     approval history.
   - [ ] Confirm codexclaw logs do not contain env values or provider response
     bodies.

## Troubleshooting Matrix

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `opencandle` is not listed | `CODEXCLAW_PLUGIN_DIRS` is unset, descriptor was not materialized, or descriptor validation failed | Run `bun run plugin:materialize:opencandle`, export `CODEXCLAW_PLUGIN_DIRS=local-plugins`, then restart codexclaw and check logs for bounded descriptor diagnostics. |
| Status shows `missing_env` | `OPENCANDLE_ROOT` is absent from the app-server/plugin-supervision environment | Export `OPENCANDLE_ROOT=/absolute/path/to/OpenCandle` in the same runtime that starts codexclaw/app-server supervision. |
| Status rejects `OPENCANDLE_ROOT` | Path is relative, missing, not a directory, or OpenCandle was not built | Use an absolute path and run `npm run build` in the OpenCandle checkout. |
| Plugin is enabled but tools are not discovered | app-server MCP reload/status did not observe the server, managed `CODEX_HOME` differs from the authenticated home, or enablement is stale after descriptor regeneration | Inspect `/plugin status opencandle`, app-server startup logs, and authenticate the managed home with `codex login --device-auth`. If status is stale, preview and confirm enablement again. |
| Container app-server cannot start the plugin | The generated descriptor command or `OPENCANDLE_ROOT` path exists only on the host, or the base image does not include Bun/OpenCandle | Use a local helper validation path, or extend the container runtime with reviewed mounts/install steps so the app-server can read the same managed config and execute the descriptor command. |
| Tool call fails during the turn | Provider/network failure, OpenCandle adapter failure, or upstream API behavior | Confirm network access from the plugin runtime and retry a bounded tool such as `get_stock_quote`. Do not paste provider response bodies into docs or logs. |
| Duplicate plugin or server id | Two configured plugin directories expose the same id/server name | Remove the duplicate descriptor directory or narrow `CODEXCLAW_PLUGIN_DIRS`. |
| Channel output includes secret-looking data | Boundary violation | Stop the runtime, keep the plugin disabled, and treat this as a release blocker before marking M5 complete. |

## Security Checklist

- [ ] Plugin remains disabled before explicit user enablement.
- [ ] Enablement preview is reviewed before `--confirm`.
- [ ] Command path and args are explicit and absolute.
- [ ] Env allowlist contains only `OPENCANDLE_ROOT`.
- [ ] Env values are not rendered in channel output.
- [ ] Network/provider metadata is visible before enablement.
- [ ] MCP elicitation is declined fail-closed.
- [ ] codexclaw state stores only plugin identity, enablement, timestamps, and
  bounded status metadata.
- [ ] No channel bot token, app-server bearer token, Codex auth file,
  codexclaw SQLite path, SSH credential, cloud credential, or broad home
  directory is passed to the plugin runtime.

## Notes

- Do not mark M5 complete until the manual validation section is completed or
  each skipped item has a dated reason.
