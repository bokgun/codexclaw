# M0 Remaining Runtime Spikes Plan

## Goal

Complete the remaining M0 app-server runtime spikes so `docs/M0-findings.md`
records exact observed method names, event names, payload shapes, and M1 gate
decisions for turn streaming, approvals, cancel/timeout, and reconnect behavior.

M0 is a protocol/runtime validation milestone, not product implementation. The
output should answer whether `codex app-server` can be treated as a reliable
external runtime for M1.

## PRD References

- PRD §3.1 Goals:
  - route channel input into Codex threads.
  - stream Codex events back to channel UX.
  - expose approval requests and return user decisions to Codex.
- PRD §6.1-§6.3:
  - WebSocket JSON-RPC framing.
  - `initialize` handshake.
  - `/readyz` health check.
  - generated schema and observed protocol names as gates.
- PRD §8.3:
  - Approval Bridge approve, reject, and Modify-as-reject-plus-follow-up semantics.
- PRD §10 and §14 R4:
  - reconnect policy.
  - stream replay is nice-to-have.
  - thread state recovery is required.
- PRD §14 R5:
  - approval may be method-specific rather than a generic boolean response.
- PRD §14 R6:
  - cancel can be non-deterministic and may imply later quarantine behavior.
- PRD §16.1-§16.5:
  - M0 validation order, success criteria, and failure branches.
- Roadmap M0:
  - M1 is blocked until turn streaming, approval, cancel/timeout, and reconnect
    behavior are observed and recorded.

## Current State

`docs/M0-findings.md` is currently blocked:

- `initialize` is observed.
- `thread/start` is observed.
- `turn/start` streaming is not yet observed.
- approval approve/reject round trip is not yet observed.
- cancel/timeout behavior is not yet understood.
- reconnect behavior is not yet understood.

Generated schemas show that approval-like server requests may include multiple
request families:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- legacy `applyPatchApproval`
- legacy `execCommandApproval`

Generated `TurnStartParams` has no idempotency-key field. Until live testing
proves another duplicate-prevention mechanism, reconnect validation must avoid
automatic prompt replay after ambiguous disconnects.

## Scope

M0 remaining work includes:

- Add spike-level observability for JSON-RPC responses, notifications, and
  server-initiated requests.
- Verify `turn/start` streamed output and turn completion.
- Verify a second safe turn can run on the same thread after completion.
- Verify diff and tool event observation with channel-summary feasibility notes.
- Verify approval approve and reject round trips for live emitted approval
  request families.
- Verify Modify feasibility only as reject plus follow-up turn.
- Verify timeout-driven cancel or interrupt behavior and whether the thread
  remains usable.
- Verify reconnect and state recovery without duplicate turn execution.
- Verify the minimal M0 pointer-store mapping behavior without implementing the
  M1 store.
- Record schema provenance and version pin status as part of the final gate.
- Update `docs/M0-findings.md` with live observations, generated-schema-only
  assumptions, and a final M0 gate decision.

## Non-Goals

M0 remaining work excludes:

- M1 router, channel adapter, scheduler, runtime host, or SQLite pointer store
  implementation.
- Telegram, Discord, Slack, or team/shared-thread behavior.
- Production Approval Bridge implementation.
- Production reconnect coordinator implementation.
- Conversation body, tool call, diff, rollout, or approval history persistence
  outside Codex storage.
- Any weakening of Codex sandbox or approval behavior.
- Any channel-command path that directly edits `AGENTS.md`.

## Ordered Tasks

### 1. Add Spike JSON-RPC Observability

Extend the spike client boundary so it can distinguish:

- client-request responses.
- server notifications.
- server-initiated JSON-RPC requests with both `id` and `method`.
- socket close and error events.

Acceptance:

- Approval-like server requests are no longer silently ignored as unknown
  responses.
- Logs identify inbound message kind, method, request id, and safe payload shape.
- Logs do not persist conversation bodies, diffs, tool arguments, or approval
  histories.
- `bun run typecheck` passes.

Depends on:

- Existing `src/codex/ws-client.ts`.

### 2. Complete Turn Streaming Probe

Start a thread, send a simple `turn/start`, and capture the response and stream
until terminal state.

Capture:

- exact `turn/start` params shape used.
- response shape.
- stream event names.
- agent delta payload shape.
- completion or error event shape.
- turn id source, if present.
- whether a second safe turn on the same thread succeeds.

Acceptance:

- `docs/M0-findings.md` records live event names and payload shape summaries for
  `turn/start` streaming.
- Checklist item `turn/start produces streamed output` is updated with pass or
  specific failure evidence.

Depends on:

- Task 1.

### 3. Complete Diff And Tool Event Probe

Use a disposable fixture workspace to trigger file-change and tool activity
without touching project trust-boundary files.

Capture:

- file change diff event names.
- diff payload shape and whether updates are chunked or whole-patch.
- command/tool start and completion event names.
- command/tool output delta event names.
- failed tool event shape.
- whether channel output can safely summarize the event without storing raw diff
  or tool payload content.

Acceptance:

- `docs/M0-findings.md` records diff/tool event names and payload shape
  summaries.
- Findings state whether M1 channel UX can summarize file names, status, and
  line-count-style metadata without persisting raw diffs or tool arguments.
- Findings record any event ordering or chunking constraints M1 must honor.

Depends on:

- Task 2.

### 4. Complete Approval Approve/Reject Probe

Trigger approval requests and respond to them using live-observed or
generated-schema-confirmed response shapes.

Attempt coverage of the approval families PRD §14 R5 and §16 call out:

- command execution approval.
- file change approval.
- network or permissions approval.

Then observe additional families only as live runtime emits them:

- tool user input.
- legacy approval methods.

For each observed approval request, record:

- method name.
- JSON-RPC id correlation behavior.
- params shape summary.
- approve response shape.
- reject response shape.
- Codex behavior after approve.
- Codex behavior after reject.

Acceptance:

- Approve and reject are attempted for command/shell, file change, and
  network/permissions approval families.
- If a family cannot be triggered, findings record the exact attempt and gate
  impact.
- At least one approve and one reject round trip succeeds before any narrower
  M0 pass can be considered.
- Findings distinguish live observations from generated-schema assumptions.
- If approval cannot be responded to by an external client, M0 records this as a
  PRD §16.5 failure candidate.

Depends on:

- Tasks 1 through 3.

### 5. Verify Modify Feasibility At M0 Level

M0 does not implement the production Modify UX. It only verifies the protocol
premise:

- reject the original approval.
- send a follow-up `turn/start` asking Codex to retry with the modified
  instruction and original action context.

Acceptance:

- Findings record whether reject plus follow-up turn works.
- Findings record enough context requirements for M1 to design Modify without
  storing approval history or tool payloads long-term.

Depends on:

- Tasks 2 and 4.

### 6. Complete Cancel/Timeout Probe

Start a long-running turn, identify the turn id source, and attempt the
verified cancel or interrupt flow.

Capture:

- turn id source.
- cancel/interrupt method.
- params shape.
- response shape.
- terminal events after cancel.
- thread status after cancel.
- whether tool work actually stops.
- whether a safe follow-up turn succeeds.

Acceptance:

- Findings record whether timeout/cancel is implementable.
- Findings record whether cancel failure should map to an M1 quarantine state.
- If cancel/timeout cannot be controlled externally, M0 records this as a PRD
  §16.5 failure candidate.

Depends on:

- Tasks 1 and 2.

### 7. Complete Reconnect And No-Duplicate Probe

Start a long-running turn, close the WebSocket mid-turn, reconnect, and recover
state without automatically replaying the original prompt.

Capture:

- reconnect sequence.
- whether `initialize` must be repeated.
- `thread/read` and/or `thread/resume` params and response shapes.
- whether missed deltas replay.
- how active, completed, failed, or unknown turn state is detected.
- whether a safe follow-up turn can run on the same thread.
- M1 rule for avoiding duplicate `turn/start` when idempotency is unavailable.

Acceptance:

- Findings record reconnect behavior clearly enough to unblock or reject M1
  reconnect design.
- Findings explicitly state that prompt replay is disallowed unless acceptance
  state is known.
- If reconnect cannot recover thread state, M0 records this as a PRD §16.5
  failure candidate.

Depends on:

- Tasks 1 and 2.
- Task 6 if turn status or cancellation is required to close the probe safely.

### 8. Validate Minimal Pointer Store Assumptions

Validate only the M0-level SQLite mapping behavior described in PRD §16.1.G.
This is not the M1 pointer-store implementation.

Capture:

- `(user_key, label) -> thread_id` storage and lookup.
- `is_default` behavior for a default label.
- `status` transition between `active` and `archived`.
- `last_routed_at` update shape.
- `suppress_branch_until` default `NULL` behavior.

Acceptance:

- Findings record that the minimal schema can represent M0 routing notes.
- Findings do not imply `missing`, `quarantined`, migrations, approval storage,
  task storage, or prefs UX are implemented.
- Any schema mismatch with PRD §8.1 is recorded before M1 store design starts.

Depends on:

- Task 2.

### 9. Update M0 And Schema Gate Decision

Update `docs/M0-findings.md` from blocked checklist notes into a gate decision.

Possible outcomes:

- `pass`: all M0 success criteria are observed and no hard failure remains.
- `blocked`: a specific spike is still missing or inconclusive.
- `ws-fallback-candidate`: WebSocket transport is the only failing layer.
- `scope-redesign-required`: approval, thread, reconnect, or cancel semantics
  are unsuitable for the PRD runtime model.

Acceptance:

- Findings include exact observed method names, event names, payload shape
  summaries, and decisions.
- Findings identify any PRD updates required before M1.
- Findings record pinned Codex CLI/app-server version and generated schema
  provenance, or explicitly mark Schema Gate as blocked.
- M1 implementation can proceed only if both M0 Gate and Schema Gate are
  explicitly `pass`.

Depends on:

- Tasks 2 through 8.

## Dependencies

- Local Codex app-server reachable through `bun run start:codex`.
- Current generated schemas under `schemas/generated/**`.
- Existing Bun scripts:
  - `bun run typecheck`
  - `bun run start:codex`
  - `bun run spike:repl`
  - `bun run spike:approval`
- Current spike files:
  - `src/codex/ws-client.ts`
  - `src/spike/cli-repl.ts`
  - `src/spike/approval-demo.ts`
- M0 must continue to use Bun commands in docs and scripts.

## Expected File Changes

Likely modifications:

- `docs/M0-findings.md`
- `src/codex/ws-client.ts`
- `src/spike/cli-repl.ts`
- `src/spike/approval-demo.ts`
- `package.json`, only if repeatable spike scripts are added.

Possible additions:

- `src/spike/turn-probe.ts`
- `src/spike/diff-tool-probe.ts`
- `src/spike/cancel-probe.ts`
- `src/spike/reconnect-probe.ts`
- `src/spike/pointer-store-probe.ts`

Likely not modified:

- `schemas/generated/**`, unless schema regeneration is handled by a separate
  explicit schema-gate task.
- `AGENTS.md`.
- M1 runtime modules.

## Type And Interface Sketches

These are sketches only. They are intended to shape spike code boundaries, not
define production APIs.

```ts
type RpcInbound =
  | {
      kind: "response";
      id: number;
      result?: JsonValue;
      error?: JsonValue;
    }
  | {
      kind: "notification";
      method: string;
      params?: JsonValue;
    }
  | {
      kind: "server_request";
      id: number;
      method: string;
      params?: JsonValue;
    };
```

```ts
type TurnObservation = {
  threadId: string;
  turnIdSource:
    | "turn_start_response"
    | "notification"
    | "thread_read"
    | "not_observed";
  streamedEvents: string[];
  completionEvent?: string;
  safeToStartNextTurn: boolean;
};
```

```ts
type ApprovalObservation = {
  method: string;
  requestId: number;
  approveShape: "observed_live" | "generated_schema_only";
  rejectShape: "observed_live" | "generated_schema_only";
  postApproveBehavior: string;
  postRejectBehavior: string;
};
```

## Pseudocode

Turn streaming:

1. Connect to app-server.
2. Send `initialize`.
3. Send `thread/start`.
4. Send `turn/start` with a simple prompt.
5. Log inbound response, notification, and server request kinds.
6. Wait for turn completion, error, or bounded timeout.
7. Send a second safe prompt to the same thread.
8. Record observed shapes and outcome in findings.

Approval:

1. Connect and start a thread.
2. Send an approval-inducing prompt.
3. Wait for a server request.
4. Classify request by method name.
5. Record request id and safe params shape summary.
6. Respond with approve shape.
7. Repeat a fresh run with reject shape.
8. Record Codex behavior after each response.

Diff/tool events:

1. Connect and start a thread in a disposable fixture workspace.
2. Ask Codex to make a trivial file change.
3. Record diff update, file change, and item lifecycle event shapes.
4. Ask Codex to run one harmless command and one intentionally failing command.
5. Record tool start, output delta, completion, and failure event shapes.
6. Record summary-safe metadata that M1 can send to channels.

Modify feasibility:

1. Trigger an approval request.
2. Reject the original request.
3. Send a follow-up turn asking Codex to retry with modified instructions.
4. Record whether the thread accepts and executes the follow-up.

Cancel/timeout:

1. Start a long-running turn.
2. Capture turn id from response, notification, or thread read.
3. After a bounded timeout, send verified cancel or interrupt request.
4. Wait for response and terminal events.
5. Read thread status.
6. Send a harmless follow-up turn.
7. Record whether M1 can safely implement timeout and quarantine fallback.

Reconnect:

1. Start a long-running turn.
2. Close the WebSocket before completion.
3. Reconnect and initialize.
4. Read or resume the same thread.
5. Do not replay the original prompt automatically.
6. Determine state from app-server responses.
7. Send a safe follow-up only after state is known.
8. Record M1 reconnect rule.

Minimal pointer store:

1. Create a temporary SQLite database.
2. Create only the PRD §16.1.G minimal `threads` shape.
3. Store and read one default thread mapping.
4. Store and read one named thread mapping.
5. Update active to archived and record the state transition.
6. Confirm `suppress_branch_until` defaults to `NULL`.
7. Record whether this validates only M0 assumptions or reveals a PRD mismatch.

## Validation Criteria

- `bun run typecheck` passes after spike tooling changes.
- M0 findings include live evidence for:
  - `turn/start` streamed output.
  - diff and tool event observation.
  - approval approve/reject round trip.
  - cancel/timeout behavior.
  - reconnect without duplicate turn execution.
- M0 findings include minimal pointer-store validation notes.
- M0 findings include schema provenance and version pin status.
- Findings distinguish live observations from generated-schema assumptions.
- Findings explicitly state whether M0 Gate and Schema Gate allow M1 to proceed.
- No spike stores conversation bodies, tool-call payloads, diffs, rollout data,
  or approval histories outside Codex rollout storage.
- Any discovered PRD mismatch is recorded as a decision, not silently absorbed
  into M1 design.

## Risks And Unknowns

| Risk / Unknown | Impact | Smallest Spike |
| --- | --- | --- |
| Existing client may ignore server requests with both `id` and `method`. | Approval cannot work. | Add JSON-RPC inbound classification and observe one approval request. |
| Diff/tool events may be too verbose or chunked for direct channel output. | M1 channel streaming could leak or overwhelm users. | Trigger one disposable file change and one failing tool command; record summary-safe metadata. |
| Approval methods may be request-specific, not generic `serverRequest/approval`. | PRD §8.3 mapping may need correction. | Exercise command and file approval first; record additional families as emitted. |
| Permission approval reject shape is unclear from generated schemas. | Reject behavior may be ambiguous. | Trigger permission request and record live accepted/rejected response mechanics. |
| `TurnStartParams` has no idempotency key. | Automatic replay after reconnect could duplicate execution. | Reconnect mid-turn and prove a state recovery path that avoids replay. |
| Cancel may require a turn id whose source is not obvious. | Timeout cannot be implemented safely. | Capture turn id source from response, notifications, or `thread/read`. |
| Cancel may leave tool work running or thread busy. | M0 may fail or M1 may need quarantine behavior. | Cancel one long turn and immediately attempt a harmless follow-up. |
| Missed deltas may not replay after reconnect. | Channel UX must report state recovery instead of perfect stream replay. | Reconnect mid-turn and compare read/resume behavior to live deltas. |
| Generated schema provenance may be ambient and unpinned. | Schema Gate blocks M1 even if runtime behavior passes. | Record exact Codex CLI/app-server version and how `schemas/generated/**` was produced. |

## Review History

| Round | Reviewer | Date | Findings | Resolution |
| --- | --- | --- | --- | --- |
| 0 | planner | 2026-05-01 | Initial plan draft for remaining M0 spikes. | Written to plan document. |
| 1 | implementation-reviewer | 2026-05-01 | Missing diff/tool event probe, minimal pointer-store validation, multi-family approval coverage, and Schema Gate handling. | Added Tasks 3, 8, and 9 updates; strengthened approval and validation criteria. |
