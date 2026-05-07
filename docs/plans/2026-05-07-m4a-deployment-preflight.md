# M4a Deployment Preflight Plan

## Goal

Make codexclaw startup refuse unsafe deployment shapes before any CLI,
Telegram, Discord, scheduler, or wiki route can send work to Codex. This slice
owns runtime path, token, state, WebSocket, app-server helper alignment, and
logging preflight behavior while preserving local-only developer convenience
behind an explicit opt-in.

## PRD References

- PRD section 5.3: recommended container isolation model.
- PRD sections 6.1 and 6.4: WebSocket transport, `/readyz`, bearer token file,
  and reverse proxy requirement for public exposure.
- PRD section 9: token permissions, WSS for non-local exposure, and no sandbox
  or approval weakening.
- PRD section 10: JSON-line stderr logs and Bun/TypeScript runtime.
- PRD section 11: minimal `.env` configuration.
- `docs/ROADMAP.md` M4: WSS docs, token checks, safe prompts, and deployment
  defaults.
- `README.md` local CLI runtime configuration, which currently documents the
  existing workspace/state env surface.

## Parent Plan

- `docs/plans/2026-05-07-m4-hardening-deployment.md`
- Covers parent task 2, preflight-related docs from task 1, and the
  runtime-facing part of task 10.

## Scope

- Add codexclaw deployment mode policy under `CODEXCLAW_DEPLOYMENT_MODE`.
  Allowed values:
  - `local_dev`: explicit local-only developer mode. May allow state inside the
    workspace only when `CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE=true`.
  - `local_loopback`: default safe local runtime. Requires loopback `ws://` or
    `wss://`; keeps state, token, and SQLite outside the workspace.
  - `reverse_proxy_wss`: remote-channel deployment mode. Requires `wss://` for
    Codex app-server URLs and keeps state, token, and SQLite outside the
    workspace.
- Keep default deployment state outside `CODEXCLAW_WORKSPACE_ROOT`, such as
  `~/.codexclaw`, unless explicit local-dev opt-in is selected.
- Validate `CODEXCLAW_STATE_DIR`, `CODEXCLAW_DB`, and
  `CODEXCLAW_CODEX_TOKEN_FILE` through one shared preflight path.
- Refuse symlink token files and symlink state dirs.
- Refuse existing SQLite database symlinks, and validate existing database
  realpaths before accepting them as outside the workspace boundary.
- Require token files to be regular files and not group/world accessible.
- Require state dirs to be private after permission tightening.
- Create missing token files only for explicit local helper/local-dev flows.
  In `reverse_proxy_wss`, a missing token file fails preflight because the
  client must use the bearer token configured for the remote/proxied app-server.
- Keep `ws://` limited to loopback; require `wss://` for non-loopback hosts.
- Add `CODEXCLAW_LOG_LEVEL` parsing and keep JSON-line stderr as the only M4a
  log format. `LOG_FORMAT=json` may be accepted as documentation-friendly no-op
  only if it does not create alternate formats.
- Align `scripts/start-codex-app-server.sh` defaults with runtime path policy so
  `bun run start:codex` does not reintroduce workspace-internal state by
  default.

## Non-goals

- No thread sync, drift detection, archive recovery, or skill inspection.
- No installer implementation beyond config behavior needed by M4e.
- No Docker/container artifacts; those belong to M4d.
- No changes to Codex sandbox or approval policy.

## Ordered Tasks

1. Introduce deployment mode parsing in `src/config/env.ts`.
   - Dependencies: existing dotenv loader and runtime path config.
   - Validation: tests reject unknown modes and assert the default mode keeps
     state outside `CODEXCLAW_WORKSPACE_ROOT`.

2. Specify exact path resolution rules.
   - Dependencies: existing `resolveHomePath`, state-path legacy mapping, and
     `README.md` env semantics.
   - Expected rules: workspace resolves from `process.cwd()` or
     `CODEXCLAW_WORKSPACE_ROOT`; `CODEXCLAW_STATE_DIR` supports `~`, absolute
     paths, and relative paths from workspace; token and db relative values
     resolve from state dir; legacy `.codexclaw/codex.token`,
     `.codexclaw/codexclaw.sqlite`, and `.codexclaw/codexclaw.db` map into the
     selected state dir.
   - Validation: tests cover `~`, relative, absolute, and legacy values.

3. Enforce workspace/state separation.
   - Dependencies: tasks 1-2 and normalized realpath containment helper.
   - Validation: non-local-dev modes reject state, token, or db paths inside the
     workspace; local-dev permits them only with
     `CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE=true`.

4. Harden file permissions.
   - Dependencies: task 2.
   - Validation: tests cover local-mode missing token creation,
     reverse-proxy missing token refusal, owner permission tightening, token
     symlink refusal, database symlink refusal, token regular-file requirement,
     database realpath containment, and private state directory checks.

5. Keep WebSocket checks fail-closed.
   - Dependencies: task 1.
   - Validation: tests reject credentials/query params, reject non-loopback
     plaintext `ws://`, accept loopback `ws://`, and accept `wss://`.

6. Wire logging env knobs.
   - Dependencies: existing `src/runtime/log.ts` and runtime/channel logger
     creation sites.
   - Validation: tests cover `CODEXCLAW_LOG_LEVEL`, required JSON-line fields,
     secret redaction, content-like field summarization, and no alternate log
     format.

7. Align app-server helper and `.env.example`.
   - Dependencies: tasks 1-6.
   - Validation: docs and helper defaults show state/token/db outside workspace
     by default, remote allow-all-user flags disabled, and Bun commands
     preserved.

## Dependencies

- Existing `src/config/env.ts` path and token helpers.
- Existing `src/runtime/log.ts` JSON-line logger.
- Runtime logger creation sites in CLI, Telegram, Discord, scheduler, and host
  startup.
- `.env.example` and `README.md` configuration language.
- `scripts/start-codex-app-server.sh` workspace/state behavior.
- Bun test suite and strict TypeScript.
- PRD constraints around token files, WSS, and JSON-line logging.

## Files Expected To Change

- `.env.example`
- `scripts/start-codex-app-server.sh`
- `src/config/env.ts`
- `src/runtime/host.ts`
- `src/runtime/log.ts`
- `test/config/env.test.ts`
- `test/runtime/log.test.ts`

## Type And Interface Sketches

```ts
type DeploymentMode = "local_dev" | "local_loopback" | "reverse_proxy_wss";

interface RuntimePathConfig {
  workspaceRoot: string;
  stateDir: string;
  dbPath: string;
  deploymentMode: DeploymentMode;
  allowWorkspaceInternalState: boolean;
}

interface PathPolicyDecision {
  path: string;
  role: "workspace" | "state" | "token" | "db";
  insideWorkspace: boolean;
  allowed: boolean;
  reason?: string;
}

interface WebSocketPolicy {
  url: string;
  protocol: "ws:" | "wss:";
  loopback: boolean;
  allowed: boolean;
}

interface LogConfig {
  minLevel: "debug" | "info" | "warn" | "error";
  format: "json";
}
```

## Pseudocode

```text
startup preflight:
  load .env once
  parse CODEXCLAW_DEPLOYMENT_MODE
  resolve and realpath CODEXCLAW_WORKSPACE_ROOT
  resolve CODEXCLAW_STATE_DIR using exact documented rules
  resolve CODEXCLAW_DB and CODEXCLAW_CODEX_TOKEN_FILE from state dir
  reject symlink state dir or token file before following them
  if deployment mode is not local_dev:
    reject state/token/db inside workspace
  if deployment mode is local_dev but workspace-internal state lacks opt-in:
    reject state/token/db inside workspace
  create/tighten private state dir
  if token file is missing and deployment mode is reverse_proxy_wss:
    fail preflight
  if token file is missing and mode is an explicit local helper/local-dev flow:
    create token file
  tighten token file
  reject existing database symlink or database realpath inside workspace
  validate Codex WebSocket URL
  initialize JSON-line logger from CODEXCLAW_LOG_LEVEL
  only then construct channel adapters, scheduler, wiki, and router
```

## Validation

- `bun test test/config/env.test.ts test/runtime/log.test.ts`
- `bun run typecheck`
- Focused coverage:
  - local-mode missing token creation
  - reverse-proxy missing token refusal
  - token permission tightening
  - token symlink refusal
  - database symlink refusal and database realpath containment
  - state dir symlink refusal
  - non-loopback `ws://` rejection
  - `wss://` acceptance
  - deployment-mode rejection of workspace-internal state/token/db
  - explicit local-dev workspace-internal opt-in
  - `~` and relative path resolution
  - log level filtering and redaction
  - app-server helper defaults match runtime defaults

## Risks And Unknowns

- Risk: existing tests assume workspace-internal state. Mitigation: update tests
  and docs together so the new default is intentional.
- Risk: path containment checks can be fooled by prefixes. Mitigation: compare
  normalized path segments, not raw string prefixes.
- Unknown: cross-platform symlink and chmod behavior. Smallest spike: focused
  Bun tests using temp dirs and symlinks on the supported host.
- Unknown: whether defaulting state outside the workspace breaks fresh-clone CLI
  flow. Smallest spike: run local CLI smoke with default env after M4a.
- Unknown: whether every channel startup calls preflight early enough. Smallest
  spike: code-read and tests for CLI, Telegram, Discord, and scheduler startup
  construction order.

## Review History

| Round | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 0 | main | 2026-05-07 | draft | Split from committed M4 parent plan. |
| 1 | planner | 2026-05-07 | fixes applied | Added PRD references, exact deployment-mode semantics, helper alignment, required plan sections, and task-level validation. |
| 2 | implementation-reviewer | 2026-05-07 | fixes applied | Scoped token creation by deployment mode, added DB symlink/realpath validation, fixed path dependency, and narrowed parent-task mapping. |
| 3 | implementation-reviewer | 2026-05-07 | no findings | Re-reviewed all five M4 subplans after fixes. |
