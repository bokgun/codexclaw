# M4b Thread Sync And Drift Plan

## Goal

Make thread routing resilient when Codex rollout state changes outside
codexclaw. This slice adds bounded capability probing, boot-time pointer sync,
route-time drift detection, and consistent handling for active, archived,
missing, and quarantined pointers without replaying prompts or reading turns.

## PRD References

- PRD section 8.1: Codex rollout storage remains the source of truth;
  codexclaw stores only pointers/status, performs boot-time `thread/list`, and
  checks drift with metadata-only `thread/read`.
- PRD section 8.4: `/threads`, `/switch`, `/archive`, and active, archived,
  missing, quarantined lifecycle behavior.
- PRD section 10 / R4: reconnect recovery uses `thread/read` plus
  `thread/resume`; no prompt replay on ambiguous recovery.
- PRD section 9: no weakening Codex sandbox or approval behavior.
- `docs/M0-findings.md` reconnect/resume findings: `thread/read` alone is not
  enough before new routing; `thread/resume` with excluded turns is required.

## Parent Plan

- `docs/plans/2026-05-07-m4-hardening-deployment.md`
- Covers parent tasks 3, 4, 5, and 6.

## Scope

- Add app-server client methods for `thread/list`, metadata-only
  `thread/read`, and capability-gated `thread/archive` and `thread/unarchive`.
- Add a bounded live probe or spike for `thread/list`, archived filters,
  `thread/archive`, `thread/unarchive`, and not-found `thread/read` shapes.
- Add boot-time sync against `thread/list` for active and archived threads in
  `CODEXCLAW_WORKSPACE_ROOT`.
- Follow `nextCursor` pagination with a page limit and bounded warnings.
- Use `thread/read` with `includeTurns: false` only as tie-breaker or
  route-time drift check.
- Normalize and compare returned thread `cwd` with `CODEXCLAW_WORKSPACE_ROOT`
  before routing or reviving a pointer.
- Refuse routing for missing, archived, quarantined, ambiguous, or mismatched
  pointers.
- Allow archived recovery only through verified `thread/unarchive` capability.
- Keep active-label invariants explicit: if the active pointer becomes
  non-routable, keep the status, refuse normal routing, and guide the user to
  `/thread new` or explicit recovery.

## Non-goals

- No persistence of conversations, turns, diffs, tool calls, approval bodies, or
  rollout replicas.
- No direct deletion or mutation of Codex rollout files.
- No `/project` namespace behavior.
- No multi-workspace routing.

## Ordered Tasks

1. Add typed runtime-client thread surfaces.
   - Dependencies: generated schemas for `ThreadListParams`,
     `ThreadListResponse`, `ThreadReadParams`, and `Thread`.
   - Validation: client tests assert cursor, `archived`, `cwd`, and
     `includeTurns: false` params, plus capability flags for archive and
     unarchive.

2. Add a bounded thread capability probe.
   - Dependencies: task 1 and pinned app-server schema.
   - Validation: probe records only method names, ids, status metadata, and
     bounded error shapes; it never records turns or rollout content.

3. Add thread metadata normalization helpers.
   - Dependencies: task 1 and M4a normalized workspace root behavior.
   - Validation: tests cover status mapping, not-found detection, ambiguous
     error classification, and normalized `cwd` mismatch.

4. Add `src/runtime/thread-sync.ts`.
   - Dependencies: tasks 1-3 and existing `PointerStore` status model.
   - Validation: tests cover active remains active, archived becomes archived,
     absent becomes missing only after complete confidence, quarantined is
     preserved, multi-page lists, page-limit warnings, partial scans, and
     bounded logs.

5. Wire boot and reconnect sync into `HostRuntime`.
   - Dependencies: task 4 and existing start/reconnect ordering.
   - Validation: host tests assert sync runs after app-server initialize and
     before active resume on startup and reconnect.

6. Add route-time drift guard.
   - Dependencies: tasks 3-5 and existing `ThreadManager.resumeThread`.
   - Validation: router, scheduler, and wiki route tests assert failures happen
     before queueing or `turn/start`, and successful paths call
     `thread/resume` with turns excluded before routing.

7. Complete status-specific command behavior.
   - Dependencies: tasks 2 and 6.
   - Validation: tests cover `/thread list`, legacy `/threads`, `/thread switch`
     archived recovery, missing refusal, quarantined refusal, scheduler refusal
     on non-active labels, `/thread archive` and legacy `/archive` success with
     verified capability, unsupported archive capability errors, active-label
     invariant preservation, branch-suggestion suppression, and no automatic
     unquarantine.

## Dependencies

- M4a path preflight or an equivalent shared normalized workspace root.
- Generated schema files under `schemas/generated`, especially thread list/read
  params and response shapes.
- Existing `PointerStore` status enum and active-label invariant.
- Existing `ThreadManager.resumeThread` behavior using `thread/read` then
  `thread/resume`.
- `HostRuntime` start/reconnect ordering and scheduler route flow.
- Existing command parser and `/thread ...` namespace.

## Files Expected To Change

- `src/codex/runtime-client.ts`
- `src/runtime/host.ts`
- `src/runtime/router.ts`
- `src/runtime/thread-sync.ts`
- `src/thread/thread-manager.ts`
- `src/channel/commands.ts`
- `src/store/pointer-store.ts` only if a small helper is needed
- `test/runtime/thread-sync.test.ts`
- `test/runtime/host.test.ts`
- `test/runtime/router.test.ts`
- `test/runtime/scheduler.test.ts`
- `test/thread/thread-manager.test.ts`
- optional `src/spike/thread-status-probe.ts`

## Type And Interface Sketches

```ts
type ObservedThreadState = "active" | "archived" | "missing" | "unknown";

interface ThreadListPage {
  threads: readonly ThreadMetadata[];
  nextCursor?: string;
  complete: boolean;
}

interface ThreadMetadata {
  threadId: string;
  cwd: string;
  archived: boolean;
  status: string;
}

interface ThreadCapabilityState {
  list: boolean;
  archive: boolean;
  unarchive: boolean;
  notFoundShape?: string;
}

interface ThreadSyncOptions {
  workspaceRoot: string;
  pageLimit: number;
}

interface ThreadSyncResult {
  checkedPointers: number;
  markedActive: number;
  markedArchived: number;
  markedMissing: number;
  preservedQuarantined: number;
  warnings: readonly string[];
}

interface ThreadRouteDecision {
  action: "route" | "unarchive_then_route" | "refuse";
  observed: ObservedThreadState;
  reason?: string;
}
```

## Pseudocode

```text
capability probe:
  list active pages with cwd filter
  list archived pages with cwd filter
  create or select disposable thread only when safe
  probe archive and unarchive
  read fake id and record bounded error shape
  expose unsupported capabilities as fail-closed booleans

boot sync:
  collect active ids and archived ids through cursor pagination
  if page limit reached, mark scan partial and warn
  for each pointer:
    preserve quarantined
    mark active or archived from list membership
    if scan is partial, keep unknown pointer unchanged
    otherwise read metadata with includeTurns false
    verify cwd equals normalized workspace root
    mark missing only on known not-found
    keep status and warn on ambiguous errors

route drift:
  before queueing work, reject local missing/archived/quarantined
  read metadata with includeTurns false
  verify cwd
  map missing or archived drift to stored status and refuse
  resume thread with turns excluded
  then allow turn/start
```

## Validation

- `bun test test/runtime/thread-sync.test.ts test/thread/thread-manager.test.ts test/runtime/router.test.ts test/runtime/scheduler.test.ts`
- `bun run typecheck`
- `bun run schema:verify`
- Route validation proves no `turn/start` happens before successful drift check
  and resume.

## Risks And Unknowns

- Unknown: live `thread/list` archived/cwd semantics. Smallest spike: disposable
  thread list with `archived: false`, `archived: true`, `cwd`, and pagination.
- Unknown: not-found/inaccessible `thread/read` error shape. Smallest spike:
  fake id and any Codex-supported disposable lifecycle path that can create an
  inaccessible thread without manually mutating rollout storage.
- Unknown: `thread/unarchive` usability. Smallest spike: archive disposable
  thread, unarchive, read metadata, and start a safe follow-up turn.
- Unknown: exact `cwd` normalization behavior. Smallest spike: compare
  schema-returned `cwd` against realpathed workspace and a symlinked path.
- Risk: sync can mark valid threads missing after incomplete scans. Mitigation:
  partial scans never mark missing without metadata confirmation.

## Review History

| Round | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 0 | main | 2026-05-07 | draft | Split from committed M4 parent plan. |
| 1 | planner | 2026-05-07 | fixes applied | Added PRD references, archive/unarchive capability scope, required sections, active-label invariant, and task-level validation. |
| 2 | implementation-reviewer | 2026-05-07 | fixes applied | Removed manual rollout mutation spike and added archive command/capability validation. |
| 3 | implementation-reviewer | 2026-05-07 | no findings | Re-reviewed all five M4 subplans after fixes. |
