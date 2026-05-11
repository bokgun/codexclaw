# M2 Telegram Channel Implementation Plan

## Goal

Ship Telegram as the first stable remote personal channel for codexclaw. The
Telegram adapter must use the existing M1 router, pointer store, approval
bridge, and Codex app-server runtime without duplicating Codex conversation,
tool, diff, approval, or rollout storage.

## PRD References

- PRD §3.1 Goals: remote channel routing, streaming output, approval bridge,
  user-level threads, pointer-only persistence.
- PRD §3.2 Non-goals: no Codex Cloud, no Slack, no shared team thread model,
  no channel-driven AGENTS.md direct edits.
- PRD §5.2: inbound channel -> router -> Codex -> outbound channel flow.
- PRD §7.1-§7.2: Telegram as a v1 channel and the adapter contract.
- PRD §8.1: pointer store boundaries and pending approval mapping.
- PRD §8.3: Approve / Reject / Modify approval UX and timeouts.
- PRD §8.4: thread lifecycle commands and 4-hour new-thread suggestion.
- PRD §9: Telegram identity, token handling, approval routing, and
  prompt-injection boundaries.
- ROADMAP M2: Telegram inbound adapter, outbound formatting, inline approval,
  Modify reply flow, branch suggestion throttle, and channel message approval
  mapping.

## Scope

- Add a Telegram channel adapter implementing the current `ChannelAdapter`
  contract.
- Add Telegram runtime entrypoint/configuration so `HostRuntime` can run with
  Telegram instead of CLI.
- Normalize Telegram text updates into M1 `NormalizedMessage` and
  `InboundMessage` fields.
- Format M1 outbound events into Telegram messages with chunking and readable
  streaming behavior.
- Implement inline approval buttons for Approve, Reject, and Modify.
- Implement Modify as a reply-mode text collection with separate timeout, then
  let the M1 Approval Bridge perform reject-plus-follow-up behavior.
- Map Telegram user identity to stable `userKey`s and reject unauthorized users
  before routing.
- Keep Telegram bot tokens and optional secret values in host config only; never
  forward them to Codex.
- Add the small core/store boundary needed for PRD §8.4 branch suggestions
  without embedding thread policy inside the Telegram adapter.
- Add tests and a manual validation checklist for Telegram.

## Non-goals

- Discord and scheduler work.
- Shared Telegram group thread semantics.
- Telegram file uploads, images, voice, stickers, or rich attachments.
- Storing Telegram conversation bodies beyond short-lived in-memory
  approval/modify/suggestion correlation state. Follow-up approval callback
  recovery may persist only pointer metadata already allowed for
  `pending_approvals`; see
  `docs/plans/2026-05-12-telegram-approval-callback-recovery.md`.
- Editing AGENTS.md directly through Telegram.
- Replacing M1 approval, routing, thread, reconnect, or pointer-store behavior.
- Webhook deployment hardening. M2 starts with long polling for the personal
  host path; webhook `secret_token` support is documented as a later M4
  deployment hardening path unless it fits without adding an HTTP server.

## Ordered Tasks

1. Configuration boundary for Telegram
   - Dependencies: existing `src/config/env.ts`.
   - Add Telegram config loading and validation for bot token, allowed user IDs,
     polling timeout, Modify timeout, optional API base URL for tests, and an
     explicit mode field.
   - Fail closed when the bot token is missing.
   - Fail closed when the allowed user list is empty unless an explicit local
     development flag is set.
   - Redact bot tokens and token-like URLs in logs and thrown config errors.
   - Treat long polling as the M2 security baseline: no public webhook listener
     exists, so Telegram `secret_token` is not applicable until webhook mode is
     introduced.

2. Telegram adapter skeleton
   - Dependencies: task 1, existing `ChannelAdapter`.
   - Add `TelegramChannelAdapter` with `receive`, `approvalResponses`, `send`,
     `requestApproval`, `acknowledge`, and `close`.
   - Prefer Telegram Bot API via Bun `fetch` and long polling to avoid adding a
     runtime dependency.
   - Isolate HTTP calls behind a small Telegram API client interface so tests can
     run without network access.
   - Ensure `close` aborts polling and closes async queues.

3. Inbound message normalization
   - Dependencies: task 2.
   - Convert allowed private-chat `message.text` updates into
     `NormalizedMessage`.
   - Use `userKey = telegram:<telegram-user-id>`.
   - Use `id = telegram:<chat-id>:<message-id>`.
   - Use `channelThreadKey = telegram:<chat-id>`.
   - Preserve `replyToMessageId` for Modify reply flow.
   - Reject unauthorized users with a short denial message and no router event.
   - Reject group/supergroup/channel updates by default to avoid shared-thread
     semantics in M2.
   - Ignore unsupported non-text updates or answer once with a bounded
     unsupported message.
   - Pass slash commands through as text so M1 Router remains the command owner.

4. Outbound Telegram formatting
   - Dependencies: task 2.
   - Map M1 outbound events to Telegram `sendMessage`, and use
     `editMessageText` only where it simplifies streaming without losing
     readable history.
   - Coalesce `agent_delta` chunks per chat to avoid one Telegram message per
     token.
   - Flush pending deltas before sending status, text, or approval prompts.
   - Respect Telegram message length limits with deterministic chunking.
   - Prefer plain text unless Markdown escaping is fully covered by tests.
   - Ensure diff/tool summaries do not include raw diff/tool bodies and do not
     persist any content in codexclaw storage.

5. Long-polling delivery semantics
   - Dependencies: tasks 2 and 3.
   - Define explicit at-least-once delivery semantics for Telegram long polling.
   - Keep Telegram `update_id` offsets and a bounded recent-update dedupe window
     in memory only. Do not persist message bodies or channel cursors in M2
     because current PRD storage boundaries do not include generic inbound
     delivery cursors.
   - Advance the next Telegram offset only after the adapter has classified an
     update as routed, rejected, ignored, or answered.
   - On process restart, accept that Telegram may replay the last unconfirmed
     update. Document this residual M2 limitation and keep persistent
     exactly-once delivery as a PRD/M4 hardening decision.
   - Stale callback queries after restart must fail closed and must not route
     user text. Follow-up approval callback recovery can send a pending approval
     response only when the app-server still holds the request and the persisted
     pending approval mapping validates.

6. Approval target binding in M1 core
   - Dependencies: existing `HostRuntime`, `EventDispatcher`, and
     `ApprovalBridge`.
   - Add a shared thread-target binding so approvals know the last channel target
     for the Codex `threadId`.
   - Pass `channelThreadKey` into `ChannelApprovalRequest` from
     `ApprovalBridge.promptPending`.
   - Preserve the existing bridge correlation checks:
     - same `userKey`
     - same channel prompt message ID
     - same `channelThreadKey` when present
   - Add bridge tests proving a Telegram approval for one chat cannot be answered
     from another chat.
   - Keep target binding as routing metadata only; do not store conversation
     bodies, commands, or approval histories.

7. Core Modify state for channel reply flows
   - Dependencies: task 6 and existing `ApprovalBridge`.
   - Add a core-owned Modify flow so Telegram can collect Modify text after the
     original approval TTL without losing the PRD's 10-minute Modify window.
   - On Modify button selection, core should reject the original Codex approval
     immediately and preserve only the minimal approval context needed to enqueue
     a later follow-up turn.
   - Store this Modify-wait state in memory only, with a separate default
     10-minute timeout.
   - On Modify reply before timeout, enqueue the follow-up turn using the
     preserved context and user text.
   - On Modify timeout, clear state and notify the user; the original approval is
     already rejected.
   - Add tests where the Modify reply arrives after the original 5-minute approval
     TTL but before the 10-minute Modify TTL and still produces the follow-up
     turn.
   - Add tests where M1 approval expiry and Modify selection race; the expected
     result is one safe resolution and no duplicate follow-up.

8. Inline approval prompt
   - Dependencies: tasks 2, 4, 6, and 7.
   - Implement `requestApproval` as a Telegram message with inline keyboard
     buttons:
     - Approve
     - Reject
     - Modify
   - Callback data carries only an opaque short correlation key and action, not
     approval prompt text, commands, diffs, tokens, or raw Codex payloads.
   - Maintain an in-memory map from opaque key to approval state.
   - Return Telegram message ID as `channelMessageId` so M1 pending approval
     mapping remains authoritative.
   - Verify callback user, chat, message, and approval state before emitting a
     channel approval decision or starting core Modify state.
   - Always answer callback queries so Telegram clients stop showing loading
     state.

9. Telegram Modify reply collection
   - Dependencies: tasks 7 and 8.
   - On Modify button:
     - Ask core to begin Modify state for the approval.
     - Send a Telegram reply prompt asking the same user to reply with modified
       instructions.
     - Record adapter-local correlation from reply prompt to core Modify state.
   - On matching reply:
     - Pass `modifyText` to the core Modify completion path.
     - Clear adapter-local Modify state.
   - On Modify timeout:
     - Let the core Modify timeout clear the preserved context.
     - Notify the user that Modify expired and the original approval had already
       been rejected.
     - Clear adapter-local Modify state.

10. Core branch-suggestion contract
   - Dependencies: existing `PointerStore`, `ThreadManager`, `Router`.
   - Add an explicit channel-independent branch suggestion contract before the
     Telegram UI work:
     - a pre-route core service that can hold an inbound message in memory for a
       short TTL;
     - a channel sink method or outbound attachment for rendering New thread /
       Continue choices;
     - a channel-neutral `branchSuggestionResponses` iterable or equivalent
       interaction stream consumed by `HostRuntime`.
   - `HostRuntime.pumpMessages()` must call this pre-route boundary before
     handing normal messages to `Router.receive`.
   - Keep Telegram responsible only for rendering buttons and returning verified
     decisions.
   - Use existing `threads.suppress_branch_until` for the 7-day continue
     suppression.
   - Add `threads.last_branch_suggested_at` as system-owned thread lifecycle
     metadata. Query the max value across a user's threads to enforce “same user
     at most once per day.” This must not use user `prefs`.
   - The boundary should be able to hold the original inbound message in memory
     while the user chooses New thread or Continue.
   - Choosing New thread maps to existing `/new` behavior before routing the
     original message.
   - Choosing Continue sets `suppress_branch_until` 7 days out for the active
     thread, records the daily suggestion timestamp, and routes the original
     message.
   - Expired or missing branch-suggestion callbacks must not route stale user
     text.

11. Telegram branch-suggestion UI
   - Dependencies: task 10.
   - Render PRD §8.4 suggestion with inline buttons:
     - New thread
     - Continue
   - Callback data uses only an opaque suggestion key and action.
   - Verify same user and chat before forwarding the decision to the core
     branch-suggestion boundary.
   - Keep the original message body only in memory for the short suggestion
     lifetime.

12. Runtime entrypoint and M1 integration
   - Dependencies: tasks 1-11.
   - Add a Telegram runtime entrypoint using `HostRuntime({ channel })`.
   - Add package script such as `bun run telegram`.
   - Ensure reconnect, approval invalidation, one-active-turn queueing, and
     pointer store reuse remain owned by M1 core.
   - Keep CLI runtime behavior unchanged.

13. Tests
    - Dependencies: tasks 2-12.
    - Add focused Bun tests:
      - Telegram update normalization.
      - User allowlist and identity mapping.
      - Group chat rejection.
      - Outbound formatting, delta coalescing, and chunking.
      - Approval callback mapping for approve/reject/modify.
      - Wrong-user/wrong-chat/wrong-message approval rejection.
      - Modify reply success, empty Modify text, stale reply, and timeout.
      - Modify reply after original approval TTL but before Modify TTL.
      - Approval chat binding via `channelThreadKey`.
      - Branch suggestion idle detection, daily throttle, 7-day suppression,
        stale callback rejection, New thread, and Continue.
      - Long-polling in-memory dedupe and stale callback handling.
      - HostRuntime wiring with a mock Telegram adapter.
      - Token redaction in config/API error paths.
    - Required commands:
      - `bun run typecheck`
      - `bun test`
      - `bun run schema:verify`

14. Manual validation checklist
    - Dependencies: tasks 1-13.
    - Add `docs/M2-manual-checklist.md` covering:
      - First Telegram message creates/routes default thread.
      - `/new`, `/threads`, and `/switch` work from Telegram.
      - Approve, Reject, and Modify work against live app-server approval
        prompts.
      - Modify timeout rejects safely.
      - Unauthorized Telegram user cannot route messages or approvals.
      - Group chat updates do not route by default.
      - Bot token does not appear in logs, DB, Codex prompts, or error text.
      - 4-hour branch suggestion New thread / Continue behavior.

## Dependencies

- M1 `ChannelAdapter`, `NormalizedMessage`, `ChannelApprovalResponse`, and
  `OutboundMessage`.
- M1 `HostRuntime`, `Router`, `ApprovalBridge`, `PointerStore`, and
  `ThreadManager`.
- New M2 core contracts for approval target binding, Modify wait state, and
  branch suggestion decisions.
- Existing Codex app-server schema and M0 approval method observations.
- Telegram Bot API long polling, callback query, inline keyboard, and message
  reply APIs.
- Bun `fetch`, `AbortController`, and timers.

## Expected File Changes

- `src/channel/telegram.ts`: Telegram adapter, API client boundary, update
  normalization, outbound formatting, callback handling.
- `src/channel/index.ts`: export Telegram adapter.
- `src/config/env.ts`: Telegram config loading and validation.
- `src/runtime/telegram.ts`: Telegram runtime entrypoint.
- `src/runtime/host.ts`: small constructor or factory integration only if
  needed, plus approval target binding and branch-suggestion response pumping.
- `src/approval/approval-bridge.ts`: approval `channelThreadKey` binding and
  core Modify wait state.
- `src/runtime/branch-suggestion.ts`: channel-independent branch suggestion
  decision boundary, if this cannot fit cleanly in existing router composition.
- `src/runtime/router.ts`: only a small pre-route hook if required.
- `src/store/pointer-store.ts`: migration and methods for
  `threads.last_branch_suggested_at`.
- `src/runtime/types.ts` or `src/channel/types.ts`: only minimal event or
  attachment sketches if approval target binding, Modify state, or branch
  suggestion needs a channel-independent callback.
- `package.json`: Telegram runtime script.
- `test/channel/telegram.test.ts`: adapter tests.
- `test/runtime/branch-suggestion.test.ts`: branch suggestion tests.
- `test/runtime/telegram-runtime.test.ts`: host wiring tests if useful.
- `docs/M2-manual-checklist.md`: manual validation checklist.
- `README.md` or an operations note: Telegram bot setup and token guidance.

## Type And Interface Sketches

```ts
type TelegramUserKey = `telegram:${string}`;
type TelegramChannelThreadKey = `telegram:${string}`;

interface TelegramConfig {
  botToken: string;
  allowedUserIds: readonly string[];
  pollTimeoutSeconds: number;
  modifyTtlMs: number;
  apiBaseUrl?: string;
  mode: "long_polling";
}

interface TelegramUpdateSketch {
  updateId: number;
  message?: TelegramMessageSketch;
  callbackQuery?: TelegramCallbackSketch;
}

interface TelegramMessageSketch {
  messageId: number;
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  fromUserId?: string;
  text?: string;
  replyToMessageId?: string;
  dateUnixSeconds: number;
}

interface TelegramApprovalState {
  approvalId: string;
  opaqueKey: string;
  userKey: TelegramUserKey;
  chatId: string;
  promptMessageId: string;
  expiresAt: string;
  mode: "pending_button" | "awaiting_modify_reply";
  modifyPromptMessageId?: string;
  modifyExpiresAt?: string;
}

interface ThreadChannelTargetSketch {
  threadId: string;
  userKey: string;
  channel: "telegram";
  channelThreadKey: TelegramChannelThreadKey;
}

interface ModifyWaitStateSketch {
  approvalId: string;
  userKey: TelegramUserKey;
  threadId: string;
  channelThreadKey: TelegramChannelThreadKey;
  originalApprovalSummary: string;
  expiresAt: string;
}

interface BranchSuggestionDecisionSketch {
  kind: "new_thread" | "continue";
  suggestionKey: string;
  userKey: TelegramUserKey;
  channelThreadKey: TelegramChannelThreadKey;
}

interface TelegramPollingStateSketch {
  nextOffset?: number;
  recentUpdateIds: readonly number[];
}
```

## Pseudocode

Inbound polling:

```text
loop until closed:
  fetch getUpdates with offset, timeout, and abort signal
  for each update:
    if update_id is in recent in-memory dedupe window:
      advance in-memory offset and continue
    if callback_query:
      handle approval or branch suggestion callback
      advance in-memory offset after callback is answered
      continue
    if message:
      if sender not allowed:
        send bounded denial
        advance in-memory offset
        continue
      if chat is not private:
        send bounded unsupported-group notice
        advance in-memory offset
        continue
      if message is modify reply:
        complete core Modify state with reply text
        clear modify state
        advance in-memory offset
        continue
      if message is text:
        emit NormalizedMessage
        advance in-memory offset after handoff
```

Approval callback:

```text
on callback query:
  parse opaque action and key
  find adapter approval state
  verify same user, chat, and prompt message
  answer callback query
  if expired:
    notify expired and emit/allow safe reject path
  if approve:
    emit approval response approve
  if reject:
    emit approval response reject
  if modify:
    begin core Modify state, which rejects original approval immediately
    set adapter awaiting_modify_reply correlation
    ask user to reply with modified instruction
```

Modify timeout:

```text
periodically scan modify states:
  for each expired awaiting_modify_reply:
    clear core Modify state if still present
    clear state
    notify user modify expired; original approval was already rejected
```

Branch suggestion:

```text
before routing a normal Telegram message:
  core reads active thread for user
  if no active thread, route normally
  if active thread idle < 4 hours, route normally
  if suppressBranchUntil is in future, route normally
  if max(lastBranchSuggestedAt across user's threads) is today, route normally
  hold original message in memory with short TTL
  set lastBranchSuggestedAt on the active thread
  send inline buttons New thread / Continue

on New thread:
  verify same user and chat
  route synthetic /new
  route original message text

on Continue:
  verify same user and chat
  set suppressBranchUntil to now + 7 days
  route original message text
```

Outbound formatting:

```text
on agent_delta:
  append to per-chat buffer
  flush after debounce or safe chunk size

on status/text:
  flush pending delta first
  send plain text chunks with reply context when appropriate

on approval prompt:
  flush pending delta first
  send text plus inline keyboard
  return Telegram message id for pending approval storage
```

## Validation Criteria

- Invalid Telegram config fails fast and redacts secrets.
- Adapter satisfies `ChannelAdapter` without Codex coupling.
- Allowed Telegram users map to stable `telegram:<id>` keys.
- Unauthorized users and non-private chats cannot route messages or approvals.
- Long agent output is readable, chunked, and not stored by codexclaw.
- Approve/Reject callbacks resolve only the intended pending approval and only
  from the bound Telegram chat.
- Modify selection immediately rejects the original Codex approval; a later
  Modify reply before the 10-minute timeout still enqueues the follow-up turn.
- Modify timeout clears preserved context, and stale replies are ignored.
- 4-hour branch suggestion follows PRD daily throttle and 7-day suppression.
- Long-polling duplicate handling is explicit: in-process duplicates are
  ignored, stale post-restart callbacks fail closed, and the later bounded
  approval callback recovery behavior is documented in the follow-up plan.
- Telegram runtime uses M1 core for routing, approvals, reconnect, and store
  persistence.
- `bun run typecheck`, `bun test`, and `bun run schema:verify` pass.
- Live M2 manual checklist passes with `bun run start:codex` and Telegram
  runtime.

## Risks And Unknowns

- Telegram long polling vs webhook
  - Risk: webhook `secret_token` gives request authenticity, but requires an
    HTTP server/deployment boundary not present in M1.
  - Mitigation: M2 uses long polling from the trusted host to Telegram and
    fail-closed allowlisted users. Webhook mode moves to M4 hardening unless it
    can be added without broad runtime changes.

- Modify timeout ownership
  - Risk: M1 approval TTL and Telegram Modify TTL can race.
  - Mitigation: move Modify wait state into core. Modify button selection rejects
    the original approval immediately, then the 10-minute Modify window controls
    only whether a follow-up turn is queued.

- Branch suggestion integration point
  - Risk: putting suggestion logic inside Telegram duplicates routing/thread
    policy.
  - Mitigation: implement a core-owned pre-route boundary and keep Telegram
    responsible only for rendering buttons and returning decisions.

- Daily suggestion throttle persistence
  - Risk: in-memory daily throttle resets on restart and violates PRD behavior.
  - Mitigation: add `threads.last_branch_suggested_at` and query across a user's
    threads. Do not use user `prefs`.

- Long-polling replay
  - Risk: without a PRD-approved persistent channel cursor, process restart may
    replay the last unconfirmed Telegram update.
  - Mitigation: M2 uses in-memory dedupe and stale callback rejection, documents
    at-least-once long-polling semantics, and avoids storing message bodies.
    Persistent exactly-once delivery requires a later PRD/storage-boundary
    decision.

- Approval chat binding
  - Risk: M1 ApprovalBridge currently lacks the channel target that
    EventDispatcher uses for streaming output.
  - Mitigation: add shared thread target binding and require `channelThreadKey`
    correlation for Telegram approvals.

- Callback data size and leakage
  - Risk: Telegram callback payload is small and visible to clients.
  - Mitigation: encode only opaque IDs and actions; keep prompt/context data in
    memory or existing pending approval mapping.

- Token leakage
  - Risk: bot token may appear in failed URL/error logs.
  - Mitigation: wrap API client errors and redaction tests with token-like
    values.

## Review History

- Round 0, 2026-05-01: Planner draft created from PRD, ROADMAP, M1 manual
  checklist, and current `src/channel`, `src/runtime`, `src/approval`,
  `src/store`, and `src/thread` contracts.
- Round 0 main-agent triage: clarified long-polling security baseline,
  core-owned branch suggestion boundary, daily suggestion throttle persistence,
  and token/callback leakage constraints before reviewer handoff.
- Round 1: Implementation reviewer found five valid issues: Modify timeout
  conflict with approval TTL, missing approval chat binding, under-specified
  branch suggestion contract, ambiguous daily throttle storage, and missing
  long-polling duplicate/stale update handling.
- Round 1 fixes: added core Modify wait state, shared approval target binding,
  explicit branch-suggestion interaction contract, `threads.last_branch_suggested_at`,
  and at-least-once long-polling semantics with in-memory dedupe and documented
  restart replay risk.
- Round 2: Implementation reviewer found no remaining valid plan issues against
  `docs/workflows.md`, PRD M2 scope, ROADMAP, or current M1 contracts.
