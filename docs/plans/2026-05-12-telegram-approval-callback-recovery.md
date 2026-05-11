# Telegram Approval Callback Recovery Plan

## Goal

Make Telegram approval buttons survive `bun run telegram` restarts when the
underlying Codex app-server can still accept the pending approval response.
Callbacks from already-sent approval messages should recover from codexclaw's
SQLite pending approval mapping, validate Telegram user/chat/message identity,
and send the intended approve or reject decision to Codex.

## PRD References

- PRD §3.1 Goals: remote channel routing, approval bridge, SQLite-backed
  pointer-only state.
- PRD §5.2: inbound channel -> router -> Codex -> outbound channel flow,
  including approval result routing.
- PRD §8.1: codexclaw may store pending approval mappings, but not
  conversation bodies, tool calls, diffs, approval histories, or raw Codex
  payloads.
- PRD §8.3: approval UX supports Approve, Reject, and Modify with bounded
  timeouts.
- PRD §9: Telegram identity, token handling, approval routing, and channel
  trust boundaries.
- `docs/M0-findings.md`: observed command/file approval methods and JSON-RPC
  response mechanics.
- `docs/plans/2026-05-01-m2-telegram-channel.md`: Telegram callback
  correlation was originally in-memory only; this plan intentionally revises
  that limitation for approval callbacks only.

## Scope

- Recover Telegram approval callbacks after Telegram runtime restart using the
  existing `pending_approvals` table as the durable recovery source.
- Preserve the current in-memory fast path for callbacks handled before restart.
- Add a persistent lookup and single-use claim path keyed by Telegram prompt
  `channelMessageId`.
- Preserve the original JSON-RPC request id type when recovering persisted
  approvals.
- Rebind recovered thread output to the Telegram chat before sending a recovered
  approval response to Codex.
- Keep approve/reject semantics identical to live callbacks.
- Fail closed for expired, mismatched, duplicate, unsupported, or no-longer-
  recoverable callbacks.
- Handle duplicate long-polling processes as an operational hazard with clear
  logging and single-use database claiming.
- Define restart-safe degraded behavior for Modify without persisting prompt
  context.

## Non-Goals

- No persistence of prompt text, command text, cwd, diffs, tool arguments, raw
  Codex params, approval decisions, or approval histories.
- No change to Codex sandbox, approval policy, or response decision semantics.
- No webhook mode, webhook signing, public HTTP endpoint, or generic Telegram
  exactly-once delivery persistence.
- No Discord callback recovery in this plan.
- No Telegram file upload support; file delivery is a separate feature.
- No promise of recovery if Codex app-server discards the pending JSON-RPC
  request across WebSocket reconnect or app-server restart.

## Ordered Tasks

1. Verify Codex approval response survivability across host reconnect.
   - Dependencies: existing M0 approval spike patterns and local
     `codex app-server`.
   - Create or update a small spike that triggers a Codex approval request,
     records approval method, JSON-RPC request id, thread id, and channel
     message id, restarts only codexclaw, reconnects, and sends the saved
     approval response id.
   - The spike must test both numeric and string JSON-RPC request ids if both
     can be observed or simulated; recovery cannot assume `String(id)` is
     equivalent to the original JSON value.
   - If Codex accepts the response over a new WebSocket, continue with durable
     callback recovery.
   - If Codex rejects or ignores the response, narrow implementation to stale
     callback UX and document that true restart recovery requires Codex protocol
     support.

2. Define the recovery data boundary.
   - Dependencies: task 1.
   - Use only pending approval domain fields:
     `channel_msg_id`, `user_key`, `thread_id`, `jsonrpc_id`,
     `approval_kind`, `channel`, `expires_at`, `created_at`, plus a bounded
     request-id type discriminator if needed.
   - Preserve JSON-RPC request id type explicitly. The current text column is
     not sufficient by itself if Codex matches response ids by exact JSON value.
   - Add schema only for request-id type preservation or if a required identity
     check cannot be derived from `channel_msg_id` and existing request fields.
   - Keep Telegram callback opaque keys out of durable storage unless review
     proves they are necessary; the recovery path should prefer the Telegram
     prompt message id.

3. Add pointer store recovery operations.
   - Dependencies: task 2.
   - Add lookup/claim operations for `pending_approvals` by channel message id.
   - Add non-consuming lookup for validation and atomic conditional claim for
     final response ownership.
   - Claim must be single-use and atomic across two SQLite connections so only
     one process can send a recovered Codex response.
   - Wrong-user, wrong-channel, and malformed recovery attempts must not consume
     a valid pending row.
   - Expired rows should be claimable for fail-closed cleanup or separately
     identifiable as expired.
   - Store tests must prove schema boundaries, JSON-RPC id type preservation,
     duplicate-claim behavior, and non-consuming mismatch validation.

4. Add ApprovalBridge recovered-response handling.
   - Dependencies: tasks 2-3.
   - If `approvalId` is present in memory, use the current live path.
   - If not, recover by `response.channelMessageId`, perform non-consuming
     validation of channel, user, thread mapping, method, and expiry, then
     atomically claim the same row before responding.
   - Do not consume the row for wrong user, wrong channel, missing thread, or
     malformed recovery metadata.
   - Before sending a recovered response to Codex, rebind the recovered thread id
     to the callback's channel target so subsequent agent/status output can
     route back to the original Telegram chat after restart.
   - Recovered approve sends the same accept response shape as live approve.
   - Recovered reject sends the same decline response shape as live reject.
   - Expired recovered callbacks decline safely when Codex can still accept the
     response, delete the row, and notify the user.
   - Missing or already-claimed callbacks do not send Codex responses.

5. Add Telegram adapter memory-miss fallback.
   - Dependencies: task 4.
   - Keep the current in-memory callback path unchanged.
   - On approval callback key miss, compute `channelMessageId` from callback
     chat id and message id, compute `userKey` and `channelThreadKey` from
     Telegram ids, and emit a recovery-capable `ChannelApprovalResponse`.
   - Unauthorized users, non-private chats, missing callback messages, and
     malformed callback data fail closed before emitting a response.
   - Existing old buttons using `cc:a:<opaque-key>:<action>` can recover because
     recovery is keyed by the Telegram prompt message id.

6. Define restart-safe Modify behavior.
   - Dependencies: tasks 2-5.
   - Live in-memory Modify remains unchanged.
   - Recovered Modify must not require persisted prompt/context.
   - Preferred policy: recovered Modify declines the original approval and tells
     the user that Modify is unavailable after restart, asking them to send a
     fresh instruction.
   - Alternative policy, only if review accepts it: start an in-memory generic
     modify wait without original context. This must not persist modified
     instruction text or original approval context.

7. Reconcile pending approvals on startup and expiry.
   - Dependencies: tasks 3-4.
   - Startup must not delete valid unexpired rows.
   - Expiry handling should account for rows persisted by a previous process.
   - `ApprovalBridge.expirePending()` should not silently delete restarted rows
     when a safe decline is possible.
   - Cleanup remains bounded to the `pending_approvals` table.
   - Add tests for a fresh process starting with persisted unexpired and expired
     rows: unexpired rows remain recoverable, while expired rows are declined
     and deleted only through the intended safe path.

8. Handle duplicate Telegram long-polling processes.
   - Dependencies: Telegram adapter API error handling and task 3.
   - Detect Telegram Bot API conflict errors from duplicate `getUpdates`
     consumers and log a clear duplicate-process/configuration problem.
   - Stop or intentionally back off rather than retrying indefinitely.
   - Keep database claim as the final protection against duplicate callback
     decisions.

9. Update tests and docs.
   - Dependencies: tasks 1-8.
   - Update README and M2 docs to state approval callbacks are recoverable after
     Telegram runtime restart when the app-server still holds the pending
     request.
   - Document residual limits: app-server restart, expired approvals, missing
     callback messages, and duplicate long-polling processes.

## Dependencies

- Codex approval request ids must remain valid across codexclaw reconnect for
  true recovery.
- Existing `pending_approvals` table must remain pointer-only and content-free.
- Telegram callback messages must include chat id and message id for recovery.
- SQLite claim semantics must be reliable with multiple Bun processes.
- Existing approval bridge response path must remain the only code path that
  sends Codex approval decisions.

## Expected File Changes

- `src/store/pointer-store.ts`: pending approval lookup/claim helpers and tests;
  schema changes only if strictly necessary.
- `src/approval/approval-bridge.ts`: recovered pending approval handling,
  expiry handling, and notifications.
- `src/channel/telegram.ts`: callback memory-miss fallback and duplicate
  polling conflict handling.
- `src/channel/types.ts`: optional recovery metadata only if needed to keep the
  channel/bridge boundary explicit.
- `src/runtime/host.ts`: startup reconciliation hook only if bridge needs one;
  recovered thread-target rebind hook or callback if the bridge cannot safely
  update runtime dispatch targets directly.
- `src/spike/*`: approval reconnect spike if existing spike cannot cover task 1.
- `test/store/pointer-store.test.ts`: atomic claim and schema-boundary tests.
- `test/approval/approval-bridge.test.ts`: recovered approve/reject/expired and
  recovered Modify behavior.
- `test/channel/telegram.test.ts`: memory-miss fallback, wrong user/chat,
  expired fallback, missing callback message, and duplicate polling conflict.
- `README.md`, `docs/M2-manual-checklist.md`, and possibly
  `docs/M2-review-checklist.md`: updated behavior and residual limits.

## Type And Interface Sketches

```ts
type ApprovalRecoveryInputSketch = {
  channelMessageId: string;
  userKey: string;
  channel: "telegram";
  decision: "approve" | "reject" | "modify";
  receivedAt: string;
  channelThreadKey?: string;
};

type PendingApprovalRecordSketch = {
  channelMsgId: string;
  userKey: string;
  threadId: string;
  jsonrpcId: string;
  jsonrpcIdType: "number" | "string";
  approvalKind: string;
  channel: "cli" | "telegram" | "discord";
  expiresAt: string;
  createdAt: string;
};

type ClaimedPendingApprovalSketch =
  | { kind: "claimed"; record: PendingApprovalRecordSketch }
  | { kind: "expired"; record: PendingApprovalRecordSketch }
  | { kind: "missing" };

type RecoveryValidationSketch =
  | { kind: "valid"; record: PendingApprovalRecordSketch }
  | { kind: "mismatch"; reason: "user" | "channel" | "thread" | "malformed" }
  | { kind: "missing" };
```

## Pseudocode

Telegram callback memory-miss path:

```text
on approval callback:
  parse action and opaque key
  if in-memory pending approval exists:
    run existing validation and emit existing response
    answer callback
    return

  if callback has no message:
    answer callback as expired or unknown
    return

  validate allowed user and private chat
  compute channelMessageId from callback message chat id and message id
  emit ChannelApprovalResponse with recovery placeholder approval id,
    channelMessageId, userKey, decision, receivedAt, and channelThreadKey
  answer callback with a neutral "received" response
```

ApprovalBridge recovered response path:

```text
on channel approval response:
  if approval id matches in-memory pending:
    use existing live path
    return

  look up pending approval by channelMessageId without consuming it
  if missing:
    log unmatched callback
    return

  validate channel and user
  validate thread id maps to known thread
  if mismatch:
    reject locally without consuming pending row
    return
  if expired:
    conditionally claim expired row, decline safely, delete row, notify user
    return

  conditionally claim row using channelMessageId plus validated user/channel
  if claim lost:
    report already resolved or expired
    return

  rebind recovered thread target to callback channelThreadKey before Codex response

  if decision is approve:
    send accept to Codex using recovered request id with original JSON type
    return

  if decision is reject:
    send decline to Codex using recovered request id with original JSON type
    return

  if decision is modify:
    decline original approval and report Modify unavailable after restart
    return
```

Duplicate process claim:

```text
before recovered Codex response:
  validate by non-consuming lookup
  atomically delete or mark the pending row using expected channel/user fields
  only the claiming process may send the Codex response
  non-claiming process treats callback as already resolved or expired
```

## Validation Criteria

- Old Telegram approval buttons sent before `bun run telegram` restart recover
  when the Codex app-server still has the pending request.
- Recovered approve/reject decisions reach Codex using existing approval
  response mechanics.
- Recovered JSON-RPC request ids preserve their original number/string type.
- Recovered approval flow rebinds thread output so post-approval agent/status
  output reaches the original Telegram chat after restart.
- Recovered callbacks do not persist forbidden content and do not weaken Codex
  approval policy.
- Expired approvals fail closed with decline, not approval.
- Duplicate callbacks and duplicate processes cannot send two Codex approval
  responses for one pending approval row.
- Unauthorized users and wrong chats cannot recover approvals and cannot consume
  a valid pending row.
- Startup reconciliation preserves unexpired rows and handles expired rows
  through the intended safe decline/delete path.
- Recovered Modify has explicit tested degraded behavior.
- Validation commands:
  - `bun test test/channel/telegram.test.ts`
  - `bun test test/approval/approval-bridge.test.ts`
  - `bun test test/store/pointer-store.test.ts`
  - `bun run typecheck`
  - `bun run schema:verify`
  - `bun test`

## Risks And Unknowns

- Codex may not accept a JSON-RPC response id over a new WebSocket. This must be
  tested before implementation commits to true recovery.
- Telegram callback queries can omit `callback.message`; recovery must fail
  closed in that case.
- SQLite atomic claim behavior must be verified across multiple store
  instances.
- Recovered thread-target rebinding must not persist message bodies and must not
  route output to a stale or attacker-controlled chat.
- Recovered Modify cannot reconstruct original approval context without
  persisting forbidden content, so degraded UX is likely preferable.
- Duplicate long-polling processes may still confuse users even if the database
  claim prevents duplicate Codex decisions.

## Review History

- Round 0: Planner subagent draft created on 2026-05-12. Main agent refined
  storage boundary, Modify policy, and validation commands before saving.
- Round 1: Implementation reviewer found missing JSON-RPC id type preservation,
  missing recovered thread-target rebinding, claim-before-validation risk, and
  missing startup reconciliation validation. Main agent accepted all findings and
  updated the plan.
