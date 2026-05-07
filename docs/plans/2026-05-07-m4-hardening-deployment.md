# M4 Hardening And Deployment Plan

## Goal

Make codexclaw safe and practical to install, operate, inspect, and deploy on a
user-owned host while preserving the PRD boundary: codexclaw remains a thin Bun
and TypeScript host above `codex app-server`, and Codex remains the source of
truth for threads, rollouts, editing, sandboxing, approvals, and agent skills.

M4 should turn the current developer-friendly runtime into something a fresh
clone user can bring up confidently with a local workspace, a private state
directory, one remote channel, and clear recovery guidance when Codex state
drifts.

## PRD References

- PRD section 5.3: recommended container isolation model.
- PRD sections 6.1-6.4: WebSocket/WSS transport, `/readyz`, bearer token file,
  and reverse proxy requirement for public exposure.
- PRD section 8.1: pointer store owns only mappings and status; boot-time
  `thread/list` sync; drift detection with `thread/read`.
- PRD section 8.4: thread lifecycle commands and active, archived, missing, and
  quarantined behavior.
- PRD section 9: token permissions, WSS, no sandbox or approval weakening, and
  `AGENTS.md` trust boundary.
- PRD section 10: JSON-line stderr logs and Raspberry Pi support.
- PRD section 11: minimal `.env` configuration.
- `docs/ROADMAP.md` M4: WSS docs, container reference, token checks,
  sync/drift, skills discovery, host skill registry, unified skills docs,
  installer, and safe prompts.
- `README.md`: existing `CODEXCLAW_WORKSPACE_ROOT`, `CODEXCLAW_STATE_DIR`,
  Telegram, Discord, scheduler, and wiki configuration.
- `docs/slash-commands.md`: `/project ...` is reserved; `/thread ...` is the
  preferred thread namespace.

## Scope

- Deployment and operations docs for local, WSS/reverse proxy, container, and
  Raspberry Pi paths.
- A reference container setup that runs `codex app-server` with explicit
  workspace and state mounts.
- Runtime preflight checks for token file permissions and non-loopback WSS
  requirements, aligned with existing `src/config/env.ts` and
  `scripts/start-codex-app-server.sh`.
- Deployment defaults that keep state, bearer tokens, and SQLite outside the
  Codex-editable workspace unless the user explicitly chooses local-only
  developer mode.
- Live capability probes for `thread/list`, archived listing, `thread/archive`,
  and `thread/unarchive` before M4 relies on archive recovery behavior.
- Boot-time thread synchronization using `thread/list` for active and archived
  Codex threads in `CODEXCLAW_WORKSPACE_ROOT`.
- Per-route drift detection using lightweight `thread/read` with
  `includeTurns: false`, including a normalized `cwd` check against
  `CODEXCLAW_WORKSPACE_ROOT`.
- Clear status handling and recovery guidance for `active`, `archived`,
  `missing`, and `quarantined`.
- Read-only Codex app-server skill discovery via `skills/list`, plus
  `skills/changed` invalidation handling.
- A host skill registry boundary for codexclaw-owned capabilities such as
  channel adapters, scheduler, wiki, and installer-visible features.
- Unified docs explaining Codex agent skills versus codexclaw host/channel
  skills.
- JSON-line logging conventions and documented redaction rules.
- Raspberry Pi 4 / 8GB smoke path.
- `codexclaw.sh` installer design with interactive prompts for workspace, state
  dir, Codex token, channel credentials, and safe defaults.
- Keep the `/project` command namespace reserved; M4 should not overload it for
  thread behavior.

## Non-goals

- No Codex Cloud integration.
- No multi-project runtime implementation behind `/project`.
- No skill execution engine, marketplace, or `/skill use <name>` flow.
- No writes to Codex skill config such as `skills/config/write`.
- No changes that weaken Codex sandbox, approval policy, or `AGENTS.md` trust
  boundaries.
- No persistence of conversation bodies, tool calls, diffs, approval histories,
  or rollout replicas.
- No full GUI dashboard or SaaS deployment model.

## Ordered Tasks

1. Add M4 deployment documentation structure
   - Dependencies: none.
   - Expected outcome: dedicated docs for local operations, WSS/reverse proxy,
     container reference, Raspberry Pi smoke, logging, skills, and installer
     behavior.
   - Validation: docs use Bun commands, reference `CODEXCLAW_WORKSPACE_ROOT`
     and `CODEXCLAW_STATE_DIR`, and state that non-loopback app-server access
     requires WSS plus token auth.

2. Harden and document runtime preflight checks
   - Dependencies: task 1.
   - Expected outcome: existing token/state checks become an explicit preflight
     surface shared by runtime startup and installer docs. Token files must be
     regular files, not symlinks, and not group/world accessible. State dir must
     be private. Deployment mode defaults must keep state, bearer token, and
     SQLite outside `CODEXCLAW_WORKSPACE_ROOT`; workspace-internal state remains
     allowed only as an explicit local-only developer choice. Plain `ws://`
     remains loopback-only.
   - Validation: focused tests cover missing token creation, permission
     tightening, symlink refusal, non-loopback `ws://` rejection, `wss://`
     acceptance, token/db outside workspace in deployment mode, explicit
     local-only opt-in for workspace-internal state, and `~`/relative path
     resolution from the correct root.

3. Add live thread status capability probes
   - Dependencies: task 2.
   - Expected outcome: a bounded probe or spike verifies `thread/list`
     pagination, archived-list filters, `thread/archive`, `thread/unarchive`,
     and not-found `thread/read` error shapes against the pinned app-server.
     If any archive/unarchive capability is unsupported, codexclaw exposes
     fail-closed capability errors and recovery guidance instead of pretending
     archive recovery works.
   - Validation: probe records only thread ids, status metadata, method names,
     and bounded error shapes; it never records turns or rollout content.
     Documentation states which capabilities are enabled for M4.

4. Add boot-time Codex thread synchronization
   - Dependencies: task 3.
   - Expected outcome: after app-server connect and initialize, codexclaw calls
     `thread/list` for active and archived threads filtered to
     `CODEXCLAW_WORKSPACE_ROOT`, then reconciles stored pointers without reading
     turns. Sync follows cursor pagination for both active and archived lists.
     Any `thread/read` tie-breaker must verify that the returned thread `cwd`
     matches the normalized workspace root before treating it as routable.
   - Validation: mock app-server tests cover active pointer remains active,
     archived pointer becomes archived, absent pointer becomes missing,
     quarantined pointer stays quarantined, multi-page active/archived lists,
     page-limit warnings, partial scans that do not mark pointers missing,
     mismatched `cwd` failing closed, and sync logs bounded metadata only.

5. Add route-time drift detection
   - Dependencies: task 4.
   - Expected outcome: before routing user or scheduler turns, codexclaw calls
     `thread/read` with `includeTurns: false` for the target thread and
     reconciles unexpected status, mismatched `cwd`, or not-found errors before
     `turn/start`.
   - Validation: tests cover successful read, read-not-found to missing,
     archived drift refusing route with recovery guidance, mismatched workspace
     `cwd` refusing route without status resurrection, and read errors that fail
     closed without duplicate turn execution.

6. Complete user-facing status handling
   - Dependencies: tasks 3-5.
   - Expected outcome: `active`, `archived`, `missing`, and `quarantined`
     produce consistent `/thread list`, `/thread switch`, scheduler, and
     branch-suggestion behavior. Archived threads can be unarchived only through
     Codex `thread/unarchive` before routing when task 3 has verified that
     capability. Missing and quarantined threads are not routed. Unsupported
     archive or unarchive capability remains a clear capability error.
   - Validation: tests cover `/thread list` status rows, `/thread switch`
     archived recovery, missing route refusal, quarantined route refusal,
     scheduler failure on non-active labels, and no automatic unquarantine.

7. Add read-only Codex skill discovery
   - Dependencies: task 2 and pinned schema gate.
   - Expected outcome: codexclaw exposes read-only `skills/list` results for the
     active workspace. It records returned fields and errors from schema types,
     labels them as Codex-scoped, and handles `skills/changed` as cache
     invalidation only.
   - Validation: schema-aware mock tests cover `skills/list` params with
     `cwds: [workspaceRoot]`, returned skills, per-cwd errors, force reload,
     changed notification invalidation, and no calls to `skills/config/write`.

8. Add host skill registry boundary
   - Dependencies: task 7.
   - Expected outcome: a static codexclaw host registry lists host/channel
     capabilities separately from Codex agent skills. Host skills describe
     metadata and enabled state only; they do not grant new execution privileges
     or bypass Codex approvals.
   - Validation: tests verify host skills are labeled `host`, Codex skills are
     labeled `codex`, disabled channel skills are visible as disabled, and
     registry entries never contain secrets or executable command bodies.

9. Add unified skills command/docs surface
   - Dependencies: tasks 7-8.
   - Expected outcome: a read-only inspection command, likely `/skills list`,
     shows Codex and host skills with source/scope labels. Docs explain Codex
     `SKILL.md` behavior, host skill metadata, wiki relation, and security
     boundaries.
   - Validation: command parser tests cover `/skills list`, unknown skill
     subcommands fail closed, output is bounded, paths are redacted or shortened
     as appropriate, and docs state that skill selection UX is post-M4.

10. Define JSON-line logging conventions
   - Dependencies: task 2.
   - Expected outcome: docs and config describe one JSON object per stderr line
     with stable fields, log levels, redaction, and content summarization. Add
     environment knobs only if needed, such as `CODEXCLAW_LOG_LEVEL` and
     `LOG_FORMAT=json`, while keeping JSON the default runtime format.
   - Validation: tests cover log level filtering, required fields, secret
     redaction, content-like field summarization, and no raw prompt/diff/tool
     output in logs.

11. Add reference container deployment artifacts
    - Dependencies: tasks 1-2.
    - Expected outcome: a bounded container reference for `codex app-server`
      with explicit workspace/state mounts, non-root guidance where feasible,
      token file mount guidance, loopback/internal networking, and reverse proxy
      examples.
    - Validation: docs or smoke script demonstrate the expected mount paths,
      token file location, `CODEXCLAW_WORKSPACE_ROOT`, `CODEXCLAW_STATE_DIR`,
      `/readyz`, and WSS proxy path. The reference must show the workspace mount
      separately from the state/token mount so Codex-editable project files do
      not contain bearer tokens or SQLite state by default.

12. Add Raspberry Pi smoke path
    - Dependencies: tasks 1, 2, 11.
    - Expected outcome: a minimal ARM64/Linux path for Pi 4 / 8GB covering Bun
      install, dependency install, schema verification constraints, local
      app-server start, CLI `/quit` smoke, and one remote-channel smoke where
      credentials are available.
    - Validation: smoke checklist can be followed without changing code;
      commands are Bun-based; resource expectations and known slow steps are
      documented.

13. Design and add `codexclaw.sh` installer workflow
    - Dependencies: tasks 1-2 and docs decisions from tasks 10-12.
    - Expected outcome: installer prompts for workspace root, state dir, Codex
      app-server URL/token file, channel selection, Telegram/Discord
      credentials, scheduler/wiki defaults, and safe deployment mode. It writes
      `.env` only after showing a summary and never enables allow-all-user local
      dev defaults for remote channels unless explicitly selected for local-only
      use. Deployment mode defaults to a state directory outside the workspace,
      such as `~/.codexclaw`, while local-only developer mode may explicitly
      choose `<workspace>/.codexclaw`.
    - Validation: installer dry-run tests cover default local setup, custom
      `CODEXCLAW_WORKSPACE_ROOT`, custom `CODEXCLAW_STATE_DIR`, state outside
      workspace, Telegram-only, Discord-only, no channel selected, non-loopback
      WSS requirement, and refusal to overwrite existing secrets without
      confirmation.

14. Update README and release checklist
    - Dependencies: tasks 1-13.
    - Expected outcome: README gives fresh-clone to first response in 15
      minutes, points to deployment docs, explains workspace/state separation,
      keeps `/project` reserved, and links skills/logging/container/Pi docs.
    - Validation: manual checklist runs through fresh clone, `bun install`,
      `.env` generation or installer dry run, `bun run schema:verify`,
      `bun run start:codex`, `bun run cli`, `/thread list`, `/skills list`, and
      `/quit`, and one documented Telegram or Discord first-response smoke on a
      supported Mac/Linux host when channel credentials are available.

## Dependencies

- Existing Bun + TypeScript runtime and tests.
- Existing `src/config/env.ts` path and token checks.
- Existing `scripts/start-codex-app-server.sh` workspace/state behavior.
- Existing `src/runtime/host.ts` reconnect and active-thread resume path.
- Existing `src/thread/thread-manager.ts` and `src/store/pointer-store.ts`
  status model.
- Pinned app-server schemas under `schemas/generated`, especially
  `thread/list`, `thread/read`, `thread/unarchive`, `skills/list`, and
  `skills/changed`.
- Existing command parser and `/thread ...` namespace.
- Existing M3.5 wiki docs and config, which must remain optional and data-only.

## Files Or Modules Expected To Change

- `README.md`
- `.env.example`
- `docs/deploy/wss-reverse-proxy.md`
- `docs/deploy/container.md`
- `docs/deploy/raspberry-pi-smoke.md`
- `docs/logging.md`
- `docs/skills.md`
- `docs/slash-commands.md`
- `docs/M4-manual-checklist.md`
- `codexclaw.sh`
- `scripts/start-codex-app-server.sh`
- `src/config/env.ts`
- `src/runtime/host.ts`
- `src/runtime/log.ts`
- `src/runtime/router.ts`
- `src/thread/thread-manager.ts`
- `src/codex/runtime-client.ts`
- `src/channel/commands.ts`
- `src/channel/types.ts`
- new `src/runtime/thread-sync.ts` or equivalent small module
- new `src/skills/*` modules for read-only discovery and host registry
- focused tests under `test/config`, `test/runtime`, `test/thread`,
  `test/channel`, and `test/skills`

## Type And Interface Sketches

```ts
type ThreadRouteStatus = "active" | "archived" | "missing" | "quarantined";

type ThreadRecoveryAction =
  | "route"
  | "unarchive_then_route"
  | "create_new_thread"
  | "switch_thread"
  | "manual_review";

interface ThreadSyncOptions {
  workspaceRoot: string;
  pageLimit: number;
  includeArchived: boolean;
}

interface ThreadSyncResult {
  checkedPointers: number;
  markedActive: number;
  markedArchived: number;
  markedMissing: number;
  preservedQuarantined: number;
  warnings: readonly string[];
}

interface ThreadDriftState {
  userKey: string;
  label: string;
  threadId: string;
  storedStatus: ThreadRouteStatus;
  observed: "present" | "archived" | "missing" | "unknown";
  recovery: ThreadRecoveryAction;
}

type SkillFamily = "codex" | "host";
type CodexSkillScope = "user" | "repo" | "system" | "admin";
type HostSkillScope = "host" | "channel" | "wiki" | "scheduler" | "installer";

interface CodexSkillSummary {
  family: "codex";
  name: string;
  description: string;
  scope: CodexSkillScope;
  path: string;
  enabled: boolean;
  cwd: string;
  errors: readonly string[];
}

interface HostSkillSummary {
  family: "host";
  name: string;
  description: string;
  scope: HostSkillScope;
  enabled: boolean;
  source: "builtin" | "configured";
  boundary: "metadata_only";
}

interface UnifiedSkillSummary {
  family: SkillFamily;
  name: string;
  scope: string;
  description: string;
  enabled: boolean;
  sourceLabel: string;
  errors: readonly string[];
}

interface InstallerAnswers {
  workspaceRoot: string;
  stateDir: string;
  codexWsUrl: string;
  tokenFile: string;
  channel: "cli" | "telegram" | "discord" | "none";
  telegramAllowedUserIds: readonly string[];
  discordAllowedUserIds: readonly string[];
  schedulerEnabled: boolean;
  wikiEnabled: boolean;
  deploymentMode: "local_dev" | "local_loopback" | "reverse_proxy_wss";
  allowWorkspaceInternalState: boolean;
}

interface JsonLogRecord {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  userKey?: string;
  channel?: string;
  threadId?: string;
  label?: string;
  status?: string;
}
```

## Pseudocode

Boot-time thread sync:

```text
on host start after app-server initialize:
  read runtime path config
  request all pages of thread/list for non-archived threads filtered by workspace cwd
  request all pages of thread/list for archived threads filtered by workspace cwd
  if page limit is reached:
    log warning
    keep unknown pointers unchanged unless thread/read confirms their state
  build activeIds and archivedIds

  for each stored thread pointer:
    if stored status is quarantined:
      preserve quarantined and continue

    if thread_id in activeIds:
      mark status active
      continue

    if thread_id in archivedIds:
      mark status archived
      continue

    attempt thread/read with includeTurns false as a tie-breaker
    if read succeeds:
      if returned cwd does not match normalized workspace root:
        keep previous status or mark missing only after explicit policy
        refuse routing and log bounded workspace mismatch
        continue
      map observed Codex runtime status to route status
    else if not found or equivalent missing error:
      mark missing
    else:
      keep previous status and log sync warning

  resume only active pointers that are currently selected
```

Route-time drift detection:

```text
before turn/start for interactive or scheduled route:
  load selected thread pointer
  if local status is quarantined:
    refuse route with /thread new guidance

  if local status is missing:
    refuse route with /thread new guidance

  if local status is archived:
    for interactive switch path, offer or perform thread/unarchive
    for scheduler path, fail run as non-routable
    stop normal routing

  call thread/read with includeTurns false
  if read succeeds and thread is routable:
    if returned cwd does not match normalized workspace root:
      fail closed before turn/start
      send workspace mismatch recovery guidance
      stop normal routing
    call thread/resume if needed
    proceed to turn/start

  if read indicates missing:
    mark missing
    refuse route

  if read indicates archived:
    mark archived
    refuse route or unarchive only on explicit switch

  if read fails ambiguously:
    fail closed without turn/start
```

Skills discovery:

```text
on /skills list:
  collect host registry entries from static codexclaw metadata
  call skills/list with cwds containing CODEXCLAW_WORKSPACE_ROOT
  normalize returned Codex skills into codex family summaries
  attach per-cwd errors as bounded messages
  merge host and Codex summaries
  sort by family, scope, name
  render read-only list with source/scope labels

on skills/changed notification:
  invalidate Codex skills cache
  do not change enabled state
  do not write skills config
```

Installer flow:

```text
print detected platform and intended safe defaults
prompt for workspace root, default current directory
prompt for deployment mode
if deployment mode is local_dev:
  prompt for state dir, default <workspace>/.codexclaw
else:
  prompt for state dir, default ~/.codexclaw
prompt for Codex WS URL, default ws://127.0.0.1:4500
if URL is non-loopback ws://:
  reject and explain WSS requirement

prompt for token file, default <state-dir>/codex.token
ensure state dir and token file will be private
if state dir or token file is inside workspace and deployment mode is not local_dev:
  reject and explain the workspace/state boundary
prompt for channel selection
for selected channel:
  ask only required credentials and allowlist ids
  default allow-all-users local dev to false

prompt for scheduler and wiki, both default disabled unless already configured
show summary without secrets
on confirmation:
  write or update .env with private permissions
  print next Bun commands
```

## Validation Criteria

- `bun run typecheck` passes.
- `bun test` passes with new focused tests for config, sync, drift, skills,
  logging, and installer dry runs.
- `bun run schema:verify` passes against pinned app-server schema.
- Local smoke: `bun run start:codex`, `bun run cli`, `/thread list`,
  `/skills list`, `/quit`.
- WSS docs include Caddy or equivalent reverse proxy config, `/readyz`, bearer
  token behavior, and no plaintext non-loopback exception.
- Container docs state exactly which paths are workspace mounts and which paths
  are state/token mounts.
- Token checks refuse symlinks and group/world-readable files.
- Deployment defaults keep token and SQLite state outside the
  `CODEXCLAW_WORKSPACE_ROOT` mount, with workspace-internal state requiring
  explicit local-only developer opt-in.
- Boot sync never reads turns and never persists Codex-owned content.
- Boot sync follows `thread/list` cursors, fails closed on page-limit overflow,
  and does not mark pointers missing from partial scans alone.
- Boot sync and route-time drift detection verify `thread/read` `cwd` against
  normalized `CODEXCLAW_WORKSPACE_ROOT` before reviving or routing a pointer.
- Drift detection prevents `turn/start` when a pointer is missing, archived,
  quarantined, or ambiguous.
- Skills listing is read-only and labels Codex skills separately from host
  skills.
- Logs are valid JSON lines and redact secrets/content-like fields.
- Installer dry run shows safe defaults and does not overwrite secrets silently.
- Fresh-clone release checklist includes at least one documented Telegram or
  Discord first-response smoke path in addition to the CLI smoke path.
- Raspberry Pi smoke path is documented with expected constraints.

## Risks And Unknowns

- Unknown: exact live `thread/list` archived semantics may differ from schema
  comments.
  - Smallest spike: run a local app-server probe that creates a thread, archives
    it if supported, calls `thread/list` with `archived: false` and
    `archived: true`, and records only ids/status metadata.

- Unknown: `thread/read` error shape for deleted or inaccessible rollout
  threads.
  - Smallest spike: call `thread/read` on a known fake id and a manually removed
    test rollout, then map the bounded error shape to missing versus ambiguous.

- Unknown: whether `thread/unarchive` is fully usable in the pinned app-server.
  - Smallest spike: archive a disposable thread, call `thread/unarchive`, then
    `thread/read` and a safe follow-up `turn/start`.

- Unknown: live `skills/list` output shape and errors across user, repo, system,
  and admin scopes.
  - Smallest spike: call `skills/list` for the workspace with and without
    `forceReload`, capture field names, scope values, and per-cwd errors without
    storing skill file contents.

- Unknown: Raspberry Pi performance and Codex CLI availability on ARM64 Linux.
  - Smallest spike: run install, `bun install`, `bun run typecheck`,
    `bun run schema:verify`, app-server `/readyz`, CLI `/quit`, and record
    timings.

- Risk: installer could normalize paths differently from runtime.
  - Mitigation: installer docs and dry-run tests must use the same path rules as
    `src/config/env.ts`: workspace-relative wiki paths, state-relative token/db
    paths, and `~` expansion.

- Risk: skills docs may imply host skills can execute or bypass Codex controls.
  - Mitigation: all host registry entries are metadata-only in M4, and docs
    state that execution remains inside Codex or existing channel/runtime code
    paths.

- Risk: thread sync could mark a valid thread missing because app-server
  pagination is incomplete.
  - Mitigation: follow `nextCursor`, use bounded page limits with warnings, and
    use `thread/read` as a tie-breaker before marking missing.

## Review History

| Round | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 0 | planner | 2026-05-07 | draft | Initial M4 plan created from PRD, roadmap, M0 findings, README, M3.5 plan, slash command docs, and current source review. |
| 1 | implementation-reviewer | 2026-05-07 | fixes applied | Accepted findings on workspace-external state defaults, archive/unarchive capability gating, `thread/list` pagination, and remote-channel release smoke. Review History already existed in the saved document, so that finding was recorded as not applicable to the current file. |
| 2 | implementation-reviewer | 2026-05-07 | fix applied | Accepted finding that boot sync and route-time drift must verify `thread/read` `cwd` against the normalized workspace root before reviving or routing stored pointers. |
