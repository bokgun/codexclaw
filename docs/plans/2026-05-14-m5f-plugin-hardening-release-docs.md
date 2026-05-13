# M5f Plugin Hardening And Release Documentation Plan

## Goal

Make M5 local MCP plugin operation supportable for a fresh clone user after the
OpenCandle production plugin slice exists. M5f should close the remaining
documentation, checklist, troubleshooting, and release-readiness gaps without
adding new plugin runtime features.

## Roadmap References

- `docs/seed/PRD.md` thin-host and storage-boundary requirements.
- `docs/ROADMAP.md` M5 MCP-backed local plugins.
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md` M5f milestone.
- `docs/plugin-boundary.md` plugin ownership and security boundary.
- M5e OpenCandle production plugin slice plan and implementation.
- Existing deployment/container docs and manual checklists:
  - `README.md`
  - `docs/M4-manual-checklist.md`
  - `docs/apple-container-checklist.md`
  - Docker/container docs in `docs/`

## Scope

- Add a README plugin section for fresh clone usage.
- Update plugin boundary docs with the final M5a-M5e behavior.
- Add or finalize an M5 plugin manual checklist.
- Add container deployment notes for local MCP plugin execution.
- Document any M5e setup/materialization command needed to produce a local
  absolute-command OpenCandle descriptor.
- Add troubleshooting for:
  - Codex auth and managed `CODEX_HOME`;
  - missing env;
  - network/provider failures;
  - app-server MCP reload/status failures;
  - disabled plugins and stale enablement;
  - duplicate plugin ids or MCP server names.
- Add a security checklist that can be used before enabling a local plugin.
- Mark M5 complete in `docs/ROADMAP.md` only after M5e validation is complete
  and the M5f docs/checklists are updated.

## Non-Goals

- New plugin descriptor fields.
- New channel commands.
- New process supervision behavior.
- Plugin marketplace, remote plugin install, or automatic plugin discovery from
  untrusted locations.
- Financial advice documentation or OpenCandle product documentation beyond the
  local MCP integration.
- Re-running all Docker or Apple Container manual tests unless the docs change
  those flows materially.

## Dependencies

- M5e must define the final OpenCandle production plugin path, descriptor, env
  requirements, and manual validation outcomes.
- M5a-M5d implementation files and docs must be treated as source of truth for:
  - descriptor validation;
  - registry discovery and enablement state;
  - app-server-managed supervision;
  - `/plugin` channel UX.
- Existing M4 deployment docs provide the container baseline; M5f should add
  plugin-specific notes rather than duplicating the whole deployment guide.

## Expected Files And Modules

- `README.md`
- `docs/ROADMAP.md`
- `docs/plugin-boundary.md`
- `docs/M5-plugin-manual-checklist.md`
- `docs/docker.md`, `docs/apple-container-checklist.md`, or the current
  container documentation files if those are the established names
- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`
- No runtime TypeScript files are expected unless documentation exposes a
  verified mismatch in existing user-facing behavior.

## Documentation Structure Sketch

The README plugin section should stay operational and short:

```text
Local MCP plugins
  - what codexclaw plugins are
  - security boundary
  - prerequisites
  - enable/inspect/disable commands
  - OpenCandle sample plugin setup
  - troubleshooting pointer
```

The manual checklist should be explicit enough to reproduce:

```text
Environment
  - host/container
  - CODEX_HOME mode
  - OPENCANDLE_ROOT
  - plugin supervision flag

Checks
  - disabled default
  - status before env
  - enable preview
  - confirmed enable
  - app-server MCP status
  - turn-mediated get_fear_greed
  - metadata-only state/log inspection
```

The security checklist should avoid implementation code and focus on operator
decisions:

```text
Before enabling a plugin
  - descriptor source is local and trusted
  - command/args are reviewed
  - env allowlist is minimal
  - network/providers are acceptable
  - no channel/app-server/Codex auth tokens are passed
  - elicitation remains fail-closed
```

## Ordered Tasks

1. Inventory existing plugin and deployment docs.
   - Identify duplicate or stale plugin statements.
   - Identify the canonical container docs for Docker and Apple Container notes.
   - Confirm the OpenCandle production path from M5e.

2. Update README.
   - Add a concise local MCP plugins section.
   - Explain disabled-by-default behavior.
   - Document any local descriptor setup/materialization step required by M5e.
   - Document `/plugin list`, `/plugin status`, `/plugin enable`,
     `/plugin enable --confirm`, and `/plugin disable`.
   - Point to the detailed checklist and security boundary.

3. Finalize the M5 manual checklist.
   - Include fresh clone prerequisites.
   - Include OpenCandle-specific setup.
   - Include expected output categories without embedding secrets or raw MCP
     payloads.
   - Mark only actually validated items as checked.

4. Add plugin-specific container notes.
   - Document where `OPENCANDLE_ROOT` should live for host, Docker, and Apple
     Container flows.
   - Document how env should be passed into the codexclaw runtime without
     baking secrets into images.
   - Document that the managed Codex home used for plugin supervision needs its
     own auth setup.

5. Update troubleshooting.
   - Map common symptoms to likely causes and recovery actions.
   - Keep examples metadata-only.
   - Include the difference between plugin disabled, missing env, app-server MCP
     reload failure, provider/network failure, and Codex auth failure.

6. Update plugin boundary and roadmap.
   - Reflect final M5e OpenCandle production-slice behavior.
   - Mark M5f implemented after docs and validation pass.
   - Mark M5 complete in `docs/ROADMAP.md` only if all M5 exit criteria are met.

7. Validate docs.
   - Check links and referenced commands.
   - Run `bun run typecheck` if runtime files changed.
   - Run focused tests only if runtime behavior changed.
   - Run `bun test` before commit if any code changed or if checklist updates
     depend on newly verified behavior.

## Important Control Flow Pseudocode

Fresh clone docs should describe this operator flow:

```text
install dependencies
authenticate Codex home used by app-server
configure codexclaw env
configure plugin directory and OPENCANDLE_ROOT
start app-server
start channel or CLI adapter
inspect /plugin list and /plugin status opencandle
preview enablement
confirm enablement
run turn-mediated tool request
disable plugin when done
```

Troubleshooting should map state to action:

```text
if plugin not listed:
  check plugin dir and descriptor validation diagnostics
if plugin listed but missing_env:
  set only required allowlisted env names
if enabled but no tool discovered:
  inspect app-server MCP reload/status
if tool discovered but call fails:
  inspect provider/network/auth conditions
if channel output exposes secrets:
  treat as release blocker
```

## Validation Criteria

- README has a clear local MCP plugin quickstart and points to detailed docs.
- Plugin boundary accurately reflects M5a-M5e implemented behavior.
- Manual checklist covers host, Docker, and Apple Container considerations where
  relevant.
- Troubleshooting covers auth, env, network/provider, disabled/stale plugin, and
  app-server MCP reload/status failures.
- Security checklist explicitly preserves:
  - disabled-by-default plugins;
  - explicit enablement;
  - env allowlist;
  - no raw MCP args/output persistence;
  - fail-closed elicitation;
  - visible network/provider metadata.
- M5 is marked complete only if M5e implementation and validation are complete.

## Risks And Unknowns

- Docs may imply the OpenCandle plugin is self-contained even though it depends
  on a local OpenCandle checkout. Keep the prerequisite explicit.
- Container paths can differ between Docker and Apple Container. Use examples
  that distinguish host path, mounted path, and env value.
- Managed `CODEX_HOME` auth can be confused with the user's normal Codex home.
  Document `codex login --device-auth` for the managed home explicitly.
- Marking M5 complete before manual validation would overstate release
  readiness. The checklist must preserve unchecked or blocked items honestly.
- If implementation changes are needed while writing docs, split them into a
  follow-up implementation workflow instead of hiding behavior changes inside
  M5f docs.

## Review History

- 2026-05-14: Initial M5f plan drafted from the M5 roadmap, M5e expected
  outputs, plugin boundary policy, and existing deployment documentation.
