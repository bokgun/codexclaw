# M1 Core Host Runtime Plan

## Goal

Build the reusable Bun + TypeScript host runtime layer above the verified `codex app-server` WebSocket protocol.

M1 turns the current spike code into a thin, testable core that future CLI, Telegram, Discord, and scheduler adapters can share. The runtime routes normalized inbound messages to Codex threads, persists only codexclaw-owned pointer data, bridges approval requests back to channels, recovers from app-server reconnects, and enforces one active turn per thread.

M1 must not reimplement Codex editing, model routing, rollout storage, sandbox policy, approval policy, or conversation persistence.

## PRD References

- PRD §1: codexclaw is a Codex frontend, router, and memory/schedule layer.
- PRD §3.1 Goals:
  - G1: stable connection and reconnection to user-owned `codex app-server`.
  - G2: at least one inbound channel, CLI recommended for early runtime.
  - G3: stream Codex events back to channel UX.
  - G4: expose approval requests and return user decisions to Codex.
  - G5: keep host code small and readable.
  - G6: user-scoped threads with default plus named threads.
  - G7: SQLite stores only pointers, labels, schedules, pending approval mappings, and prefs.
- PRD §3.2 Non-Goals:
  - no Codex internals modification.
  - no multi-provider abstraction.
  - no full GUI dashboard.
  - no Codex Cloud v1 integration.
  - no AGENTS.md direct editing through channel commands.
  - no stable shared team/community thread semantics.
- PRD §5.2: inbound normalization, pointer lookup, `thread/start`, `turn/start`, event streaming, approval result, and `last_routed_at`.
- PRD §6.1-§6.3: JSON-RPC WebSocket protocol, initialize handshake, `/readyz`, overload retry, schema pinning.
- PRD §7.2: adapter concept with receive, send, request approval, acknowledge.
- PRD §8.1: codexclaw DB owns mapping data only; Codex rollout remains SSoT for content.
- PRD §8.3: three-way approval behavior.
- PRD §8.4: thread lifecycle commands.
- Roadmap M1: router, inbox normalization, SQLite pointer store, thread commands, approval bridge, reconnect, turn concurrency guard, structured stderr logging, mock app-server tests.

## Scope

M1 includes:

- Core runtime entrypoint that composes config, Codex client, pointer store, router, thread manager, approval bridge, event dispatcher, and one CLI channel adapter.
- Normalized channel input/output contracts independent of Telegram or Discord specifics.
- SQLite-backed pointer store for:
  - user thread mappings.
  - pending approval mappings.
  - optional schema placeholders for future tasks and prefs, without implementing scheduler or prefs UX.
- Thread routing by `user_key` and label.
- Exactly one active routing label per user. M1 should resolve the PRD schema ambiguity by using a system-owned active marker in the `threads` table, while preserving `label="default"` as the default thread label.
- Slash commands:
  - `/new [label]`
  - `/threads`
  - `/switch <label>`
  - `/branch [label]`
  - `/archive <label>`
- Default thread creation when no mapping exists.
- Archived, missing, and quarantined routing behavior at the codexclaw status layer, with only the M1-safe checks that the verified protocol supports.
- Approval bridge for approve, reject, and modify.
- Modify behavior modeled as rejection of the pending approval plus a queued follow-up turn containing the original tool/command context and the modified user instruction.
- Reconnect handling for socket loss with thread state recovery.
- One active turn per thread guard with deterministic per-thread queuing, not rejection.
- Structured stderr logging.
- Mock app-server tests for routing, pointer store, approval, reconnect, and no-content-persistence constraints.
- Refactor existing spike CLI to use the shared runtime, while keeping spike scripts available or replacing them with thin wrappers.

## Non-Goals

M1 excludes:

- Telegram production adapter.
- Discord production adapter.
- Scheduler execution.
- User prefs command UX.
- Shared Discord or Slack team/thread semantics.
- Codex Cloud or managed remote runtime integration.
- WSS/reverse proxy deployment hardening beyond preserving config compatibility.
- Boot-time full `thread/list` synchronization if M0 has not verified reliable list/read/archive semantics.
- Drift detection beyond lightweight hooks supported by M0 findings.
- Daily branch suggestion throttle and 4-hour inactivity suggestion UX.
- Any storage of conversation bodies, tool calls, diffs, approval histories, or Codex rollout content.
- Any product path that directly edits `AGENTS.md` through channel commands.

## Dependencies

Implementation dependencies:

- M0 Gate must be satisfied before implementation begins:
  - `docs/M0-findings.md` must record actual method names, notification names, payload shapes, approval request/response mechanics, cancel behavior, and reconnect behavior.
  - Any M0 finding that contradicts PRD assumptions must be triaged before M1 code locks protocol abstractions.
- Generated schemas under `schemas/generated/` and `schemas/generated/v2/` remain the protocol type source.
- Bun remains the command runner and runtime.
- SQLite should use Bun built-in SQLite support unless implementation discovers a blocker requiring a documented dependency.
- Existing `src/codex/ws-client.ts` can be evolved, but must stay a generic app-server JSON-RPC client rather than gaining router/store responsibilities.

Task dependencies:

- Storage schema and domain types must land before router/thread manager tests.
- The active-thread marker must be settled before thread manager implementation. If implementation changes the PRD schema shape, update the PRD or record the decision before code lands.
- Codex transport event/request classification must land before approval bridge and reconnect tests.
- Channel adapter contracts must land before CLI runtime integration.
- Thread manager must land before slash commands are wired into the router.
- Concurrency guard must wrap turn dispatch before reconnect retry behavior is enabled.
- Approval bridge must be connected before CLI is considered M1-complete.

## Ordered Tasks

### 1. Confirm M0 Protocol Gate

Read `docs/M0-findings.md` and generated schemas before implementation.

Acceptance:

- Exact methods for thread start, read/resume/fork/archive/unarchive/list, turn start/interrupt, and approval response are known.
- Exact notification names for agent deltas, diff updates, turn completion, errors, thread status changes, and server approval requests are known.
- Client-side idempotency key support for `turn/start` is verified. If app-server does not accept an idempotency key, M1 must document the fallback and avoid automatic prompt replay after ambiguous reconnects.
- Known protocol gaps are reflected in feature flags or fallback behavior.

Blocks:

- Tasks 4 through 11.

### 2. Define Core Domain Types

Create small type modules for normalized channel messages, outbound events, routing commands, thread records, approval records, runtime config, and runtime errors.

Acceptance:

- Types express codexclaw domain data without exposing Telegram/Discord-specific concepts.
- Thread status enum matches PRD: `active`, `archived`, `missing`, `quarantined`.
- Approval decision enum matches PRD: `approve`, `reject`, `modify`.

Depends on:

- Task 1 for protocol naming confidence.

### 3. Add Pointer Store Schema And Interface

Add a SQLite-backed store with migrations.

Tables:

- `threads`
- `pending_approvals`
- `tasks`
- `prefs`

M1 should implement active behavior only for `threads` and `pending_approvals`. `tasks` and `prefs` may be created to preserve PRD schema shape, but scheduler and prefs workflows remain out of scope.

Acceptance:

- Store persists `(user_key, label) -> thread_id`.
- Store persists `is_default`, active routing marker, `status`, `last_routed_at`, `suppress_branch_until`.
- Store persists or derives exactly one active routing label per user. If a new system column is required, it must stay in the `threads` table rather than adding conversation-content storage.
- Store persists pending approval mapping with expiry.
- Store exposes no API to persist conversation text, diff text, tool-call payloads, or approval history.
- Tests assert forbidden content fields are not present in schema or write APIs.
- Tests assert that `/new`, `/switch`, and `/branch` leave exactly one active routing label for the user.

Depends on:

- Task 2.

### 4. Separate Codex Transport From Runtime Logic

Evolve `CodexWsClient` into a protocol transport that handles:

- token-file auth.
- initialize/initialized handshake.
- JSON-RPC request/notification framing.
- request correlation.
- notification subscription.
- socket close/error propagation.
- app-server overload signal surfacing.

Acceptance:

- Transport remains unaware of channel messages, thread labels, SQLite, and approvals.
- Runtime code receives typed or classified protocol events through a narrow event interface.
- Existing spike behavior still has a migration path.

Depends on:

- Task 1.

### 5. Add Codex Runtime Adapter

Add a small app-server adapter on top of the transport.

Responsibilities:

- start thread.
- resume/read thread where M0 supports it.
- fork thread for `/branch` where M0 supports it.
- archive/unarchive thread where M0 supports it.
- start turn.
- attach the verified client-side idempotency key when starting a turn, or expose an explicit capability gap when unsupported.
- interrupt/cancel turn where M0 supports it.
- send approval response using verified method/result shape.
- classify notifications into runtime event categories.

Acceptance:

- Protocol method names are centralized.
- Router code does not construct raw JSON-RPC payloads.
- Unsupported protocol actions return explicit capability errors instead of guessing.

Depends on:

- Tasks 1 and 4.

### 6. Define Channel Adapter Contract

Add a core channel interface for CLI and future adapters.

The contract should cover:

- normalized inbound messages.
- outbound text/event delivery.
- approval prompt delivery.
- approval response delivery from buttons, modals, or CLI input back to the Approval Bridge.
- optional acknowledge/typing signal.
- stable channel message ID when an approval prompt is sent.
- correlation fields that connect an approval response to the original approval prompt.

Acceptance:

- CLI can implement the interface.
- Telegram/Discord can later implement it without changing router internals.
- The interface carries `user_key`, optional channel/thread metadata, text, and timestamp.
- The interface does not carry raw Codex rollout content for persistence.

Depends on:

- Task 2.

### 7. Implement Thread Manager

Responsibilities:

- ensure default thread for user.
- create named thread.
- list known labels and statuses.
- switch active/default label.
- maintain exactly one active routing label per user without confusing it with the literal `default` label.
- branch current thread into a named label where protocol supports fork.
- archive label by updating Codex and store status.
- preserve exactly one active routing label when archiving the active label, default label, or only remaining routable label.
- resolve routable thread for normal messages.
- block routing to `missing` and `quarantined` statuses with recovery guidance.

Acceptance:

- `/new`, `/threads`, `/switch`, `/branch`, and `/archive` behavior matches Roadmap M1 and PRD §8.4.
- `/new`, `/switch`, and `/branch` update the active routing label so subsequent normal messages continue in the selected thread.
- `/archive` never leaves a user without a valid active routing label. If the archived thread was active, M1 should switch to another active-status thread or create a fresh default thread. If no safe fallback exists, the archive is blocked with recovery guidance.
- Missing or archived handling follows M1 capability boundaries documented from M0.
- Store updates `last_routed_at` only after routing attempts that should count as user activity.
- Thread manager never reads or stores conversation body content.

Depends on:

- Tasks 3 and 5.

### 8. Implement Router And Inbox Normalization

Responsibilities:

- receive normalized inbound messages.
- parse slash commands.
- route commands to thread manager.
- route normal messages to active thread.
- compose user input for Codex.
- apply one-active-turn-per-thread guard.
- dispatch outbound runtime events to channel.

Acceptance:

- Normal messages route to default label when no explicit label is active.
- Slash commands do not create Codex turns unless specified.
- Concurrent turns for the same thread are queued. The channel should acknowledge that the previous turn is still running.
- Queue order is deterministic and covered by tests.
- Router does not persist prompt bodies.

Depends on:

- Tasks 6 and 7.

### 9. Implement Event Dispatcher

Responsibilities:

- receive classified Codex notifications.
- emit agent deltas to the originating channel.
- emit diff/tool/status summaries without persisting raw payloads.
- detect turn completion/error to release concurrency guard.
- route approval requests to approval bridge.
- handle unknown events through structured logs.

Acceptance:

- Known M0 event types are handled.
- Unknown event types are logged without crashing.
- Turn completion always releases active-turn state.
- Event dispatcher does not write event payloads into SQLite.

Depends on:

- Tasks 5, 6, and 8.

### 10. Implement Approval Bridge

Responsibilities:

- map Codex approval request ID to channel approval prompt message.
- persist pending approval mapping with expiry.
- accept approve/reject/modify responses from channel.
- send verified Codex approval response.
- handle modify as rejection plus a queued follow-up turn with original tool/command context.
- expire stale approvals with auto-reject.
- enforce one active approval per thread, queueing additional approval prompts until the active approval resolves or expires.
- enforce separate timeouts for approval response and Modify text entry.

Acceptance:

- Approve and reject round trips use verified M0 protocol shapes.
- Modify does not mutate Codex approval policy; it rejects the original request and enqueues a follow-up user turn with the required original tool/command context prefix.
- Pending mappings are deleted after resolution or expiry.
- Timeout sends a verified rejection response to Codex and notifies the channel.
- Modify input timeout keeps the original request rejected and does not start the follow-up turn.
- Concurrent approvals in the same thread are queued and processed one at a time.
- Approval decision history is not persisted.
- Approval request prompt text may be sent to the channel but is not stored beyond required pending mapping identifiers.

Depends on:

- Tasks 3, 5, 6, and 8.

### 11. Implement Reconnect Coordinator

Responsibilities:

- detect transport close/error.
- pause new turn dispatch while disconnected.
- reconnect with bounded exponential backoff and jitter.
- restore notification subscriptions.
- recover active thread state from the pointer store.
- avoid duplicate turn execution after reconnect.
- use the verified idempotency key behavior for duplicate-turn prevention.
- quarantine thread if cancel/interruption uncertainty creates an unsafe state.

Acceptance:

- Reconnect lets subsequent turns continue on the same mapped thread.
- In-flight turn behavior follows M0 findings.
- No automatic replay of a user prompt occurs unless the implementation can prove the prior `turn/start` was not accepted.
- If idempotency key support is unavailable, ambiguous in-flight turns are not replayed automatically.
- Ambiguous in-flight state blocks or quarantines instead of duplicating execution.
- Tests cover reconnect before request send, after request send before response, and during streaming where feasible.

Depends on:

- Tasks 4, 5, 8, and 9.

### 12. Add Structured Logging

Add JSON-line stderr logging for runtime lifecycle, routing decisions, thread status changes, reconnect attempts, approval lifecycle, and unknown events.

Acceptance:

- Logs are machine-parseable.
- Logs exclude conversation bodies, diffs, tool-call arguments, secrets, and approval decision history.
- Log records include enough IDs for debugging: user key hash or normalized key, label, thread ID, turn ID where available, event kind, and error category.

Depends on:

- Tasks 2 through 11 as integration points become available.

### 13. Refactor CLI To Shared Runtime

Replace spike-only CLI flow with a CLI adapter that uses the M1 runtime.

Acceptance:

- CLI can start the runtime, accept user input, run slash commands, stream Codex output, and handle approval prompts.
- Existing `bun run spike:repl` either remains as a compatibility wrapper or is replaced by an equivalent M1 CLI command documented in `package.json`.
- The CLI path exercises the same router, pointer store, approval bridge, and reconnect code future channels will use.

Depends on:

- Tasks 6 through 12.

### 14. Add Focused Tests

Add mock app-server and store tests.

Coverage:

- pointer store migrations and CRUD.
- no forbidden persistence fields.
- default thread creation and routing.
- slash command parsing and behavior.
- one active turn per thread guard.
- approval approve/reject/modify flow.
- reconnect state recovery and duplicate-turn prevention.
- unknown event logging behavior.
- CLI adapter contract at a unit level where practical.

Acceptance:

- `bun test` or an equivalent Bun test script exists.
- `bun run typecheck` passes.
- Tests do not require a real Codex app-server.
- Any real app-server smoke test remains separate from unit tests.

Depends on:

- Tasks 3 through 13.

### 15. Update Documentation

Update README or M1 docs only as needed for the new runtime command, environment variables, and local CLI usage.

Acceptance:

- Docs use Bun commands.
- Docs clarify M1 non-goals.
- Docs state Codex rollout remains the conversation SSoT.
- Docs do not imply Telegram, Discord, or scheduler are complete.

Depends on:

- Task 13.

## Expected File Changes

Likely additions:

- `src/runtime/types.ts`
- `src/runtime/host.ts`
- `src/runtime/router.ts`
- `src/runtime/events.ts`
- `src/runtime/reconnect.ts`
- `src/runtime/log.ts`
- `src/runtime/errors.ts`
- `src/channel/types.ts`
- `src/channel/cli.ts`
- `src/thread/thread-manager.ts`
- `src/thread/commands.ts`
- `src/store/pointer-store.ts`
- `src/store/schema.ts`
- `src/store/migrations.ts`
- `src/approval/approval-bridge.ts`
- `src/codex/runtime-client.ts`
- `src/test/mock-codex-server.ts`
- `src/**/*.test.ts`

Likely modifications:

- `src/codex/ws-client.ts`
- `src/codex/input.ts`
- `src/config/env.ts`
- `src/spike/cli-repl.ts`
- `src/spike/approval-demo.ts`
- `package.json`
- `tsconfig.json` only if test/runtime module resolution requires it.
- `README.md` for M1 runtime usage.
- `docs/M0-findings.md` only if implementation discovers missing protocol details during validation; this should be treated as M0 gate follow-up, not as silent M1 drift.

Likely not modified:

- `AGENTS.md`, except through separate human-reviewed documentation work. Runtime/product behavior must not directly edit it through channel commands.
- `schemas/generated/**`, unless schema regeneration is explicitly part of a separate schema-gate task.

## Type And Interface Sketches

These are sketches only. Names may change during implementation to match existing code style and M0 findings.

```ts
type UserKey = string;
type ThreadId = string;
type ThreadLabel = string;
type ChannelName = "cli" | "telegram" | "discord";
type TimestampIso = string;

type ThreadRouteStatus =
  | "active"
  | "archived"
  | "missing"
  | "quarantined";

type ApprovalDecisionKind =
  | "approve"
  | "reject"
  | "modify";

type CodexApprovalWireDecision =
  | "approved"
  | "rejected";

type RuntimeEventKind =
  | "agent_delta"
  | "diff_updated"
  | "tool_event"
  | "approval_requested"
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "thread_status_changed"
  | "unknown";
```

```ts
interface InboundMessage {
  channel: ChannelName;
  channelMessageId: string;
  userKey: UserKey;
  text: string;
  receivedAt: TimestampIso;
  channelThreadKey?: string;
}

interface OutboundMessage {
  channel: ChannelName;
  userKey: UserKey;
  channelThreadKey?: string;
  text: string;
  attachments?: OutboundAttachment[];
}

interface OutboundAttachment {
  kind: "approval_actions" | "diff_summary" | "status";
  data: unknown;
}
```

```ts
interface ChannelAdapter {
  name: ChannelName;
  receive: AsyncIterable<InboundMessage>;
  send: ChannelSendOperation;
  requestApproval: ChannelApprovalOperation;
  acknowledge?: ChannelAcknowledgeOperation;
}

interface ChannelSendResult {
  channelMessageId?: string;
}

interface ChannelApprovalRequest {
  userKey: UserKey;
  threadId: ThreadId;
  prompt: string;
  options: ApprovalDecisionKind[];
  expiresAt: TimestampIso;
}

interface ChannelApprovalPrompt {
  channelMessageId: string;
}

interface ChannelApprovalResponse {
  channelMessageId: string;
  userKey: UserKey;
  decision: ApprovalDecisionKind;
  modifyText?: string;
  receivedAt: TimestampIso;
}

type ChannelSendOperation = "sends one outbound message";
type ChannelApprovalOperation = "renders an approval prompt and returns a channel message id";
type ChannelApprovalResponseOperation = "delivers button, modal, or CLI approval responses to the approval bridge";
type ChannelAcknowledgeOperation = "optionally sends seen or typing acknowledgement";
```

```ts
interface ThreadRecord {
  userKey: UserKey;
  label: ThreadLabel;
  threadId: ThreadId;
  isDefault: boolean;
  isActive: boolean;
  status: ThreadRouteStatus;
  lastRoutedAt?: TimestampIso;
  suppressBranchUntil?: TimestampIso;
}

interface PendingApprovalRecord {
  channelMessageId: string;
  threadId: ThreadId;
  jsonrpcId: string;
  expiresAt: TimestampIso;
}
```

```ts
interface PointerStore {
  lifecycle: "migrate and close store resources";
  threads: "get, list, upsert, set default, set status, touch";
  pendingApprovals: "create, get, delete, delete expired";
}
```

```ts
interface CodexRuntimeClient {
  lifecycle: "connect, close, subscribe to classified events";
  threads: "start, read, resume, fork, archive, unarchive";
  turns: "start turn and interrupt turn";
  approvals: "respond to approval requests using verified protocol shape";
}

interface StartTurnRequest {
  threadId: ThreadId;
  userText: string;
  userKey: UserKey;
  label: ThreadLabel;
  idempotencyKey: string;
}

interface ApprovalResponseRequest {
  threadId: ThreadId;
  jsonrpcId: string;
  decision: CodexApprovalWireDecision;
}
```

```ts
interface ThreadManager {
  routing: "resolve a routable thread for a user message";
  commands: "handle thread lifecycle slash commands";
}

interface ResolvedThread {
  threadId: ThreadId;
  label: ThreadLabel;
  status: ThreadRouteStatus;
}

interface CommandResult {
  handled: boolean;
  outbound?: OutboundMessage[];
}
```

```ts
interface RuntimeHost {
  lifecycle: "start and stop the composed runtime";
}

interface RuntimeConfig {
  codexWsUrl: string;
  codexTokenFile: string;
  databasePath: string;
  clientName: string;
  clientTitle: string;
  clientVersion: string;
  reconnect: ReconnectPolicy;
  approvals: ApprovalPolicy;
}

interface ReconnectPolicy {
  minDelayMs: number;
  maxDelayMs: number;
  maxAttempts?: number;
}

interface ApprovalPolicy {
  defaultTimeoutMs: number;
}
```

## Pseudocode

### Host Startup

```text
load runtime config
open pointer store
run migrations
create codex transport
create codex runtime client
create channel adapters
create thread manager
create router
create event dispatcher
create approval bridge
connect codex client
attach codex event dispatcher
start receiving channel messages
for each inbound message:
  pass message to router
on shutdown:
  stop receiving
  close codex client
  close store
```

### Normal Message Routing

```text
router receives inbound message
if message text is slash command:
  parse command
  ask thread manager to handle command
  send command result messages
  stop

ask thread manager to resolve routable thread for user
if thread status is archived:
  attempt unarchive only if protocol capability is verified
  otherwise send recovery guidance
  stop

if thread status is missing or quarantined:
  send recovery guidance
  stop

if active turn guard says thread already has active turn:
  enqueue message for the same thread
  send queued acknowledgement
  stop

mark thread as active in turn guard
create or attach verified idempotency key
ask codex runtime client to start turn with thread id, user input, and idempotency key
touch thread last_routed_at
event dispatcher streams later Codex notifications to channel
```

### Default Thread Resolution

```text
thread manager looks up default label for user
thread manager checks active routing marker for user
if active mapping exists:
  return active mapped thread

if archived mapping exists:
  return archived status to router

if missing or quarantined mapping exists:
  return blocked status to router

start new Codex thread
store mapping user_key plus default label plus thread_id
mark it default and active
return new thread
```

### Slash Command Handling

```text
/new optional_label:
  choose label or default replacement label
  start Codex thread
  upsert active thread mapping
  clear prior active marker for the user
  mark new label active
  preserve label default semantics separately from active routing
  send created message

/threads:
  list store records for user
  send labels, statuses, and active/default marker

/switch label:
  look up label
  if not found, send not found message
  if status blocks routing, send recovery guidance
  clear prior active marker for the user
  mark selected label active
  send switched message

/branch optional_label:
  resolve current thread
  if fork capability unavailable, send unsupported message
  fork current Codex thread
  store new label mapping
  clear prior active marker for the user
  switch to new label
  send branched message

/archive label:
  look up label
  if not found, send not found message
  if label is active and no alternative active-status thread exists:
    create fresh default thread or block archive with recovery guidance
  if label is active and an alternative active-status thread exists:
    choose fallback active label deterministically
  call Codex archive when capability exists
  update store status to archived
  if archived label was active:
    clear prior active marker
    mark fallback label active
  preserve default label semantics separately from active routing
  send archived message
```

### Approval Request Flow

```text
event dispatcher receives Codex approval request
extract thread id, jsonrpc id, prompt, and supported decisions
if thread already has an active approval:
  queue approval request for the same thread
  stop
approval bridge asks channel to render approval prompt
store pending approval mapping with channel message id, thread id, jsonrpc id, expiry
wait for channel approval response until approval timeout

on approve:
  read pending approval
  send approval response to Codex
  delete pending approval
  promote next queued approval for thread if present

on reject:
  read pending approval
  send rejection response to Codex
  delete pending approval
  promote next queued approval for thread if present

on modify:
  read pending approval
  send rejection response to Codex
  delete pending approval
  wait for Modify text until Modify input timeout
  if Modify text arrives:
    compose follow-up turn with original tool or command context prefix
    enqueue follow-up turn through the same per-thread turn queue and idempotency path
  otherwise:
    notify channel that Modify expired without a follow-up turn
  promote next queued approval for thread if present

on approval timeout:
  read pending approval
  send rejection response to Codex
  delete pending approval
  notify channel that approval expired
  promote next queued approval for thread if present
```

### Reconnect Flow

```text
transport reports close or connection error
runtime marks connection disconnected
router stops starting new turns
active in-flight turns are marked uncertain
start reconnect loop with bounded backoff and jitter

on reconnect success:
  re-run initialize handshake
  reattach notification handlers
  restore thread mappings from pointer store
  for each uncertain in-flight thread:
    apply M0-defined recovery behavior
    if acceptance/completion cannot be proven:
      quarantine thread or ask user before continuing
  allow new turns again

on reconnect failure after policy limit:
  send channel-visible degraded status where possible
  keep process alive or exit according to runtime config
```

### Turn Concurrency Guard

```text
before startTurn:
  check active turn map by thread id
  if active exists:
    enqueue message for the same thread
    send queued acknowledgement
  otherwise mark active with request metadata

on turn completed, failed, interrupted, or quarantined:
  clear active marker
  start next queued message for the same thread if present

on reconnect uncertainty:
  mark active marker uncertain
  release only after recovery decision
```

### No Forbidden Persistence

```text
when writing to pointer store:
  allow only codexclaw domain records
  reject or ignore fields representing:
    conversation text
    assistant text
    tool calls
    diffs
    approval decisions
    rollout snapshots
tests inspect schema and store API writes for forbidden fields
```

## Validation Criteria

Required checks:

- `bun run typecheck` passes.
- `bun test` or the M1 test command passes.
- CLI runtime can:
  - connect to app-server.
  - create or reuse default thread.
  - send normal input.
  - stream assistant deltas.
  - run `/new`, `/threads`, `/switch`, `/branch`, and `/archive` within verified protocol capabilities.
  - handle approval approve, reject, and modify.
- Mock app-server tests cover:
  - initialize and initialized handshake.
  - default thread creation.
  - existing thread reuse.
  - named thread routing.
  - slash command routing.
  - archiving active, default, and only remaining routable labels without violating the active-thread invariant.
  - active turn guard.
  - per-thread turn queue ordering.
  - approval pending mapping lifecycle.
  - channel approval response ingress and correlation.
  - approval timeout auto-reject, Modify input timeout, and one-active-approval queueing.
  - Modify follow-up context prefix and queue path.
  - reconnect without duplicate turn replay.
  - verified idempotency key behavior or documented fallback.
  - unknown notification logging.
- SQLite validation confirms:
  - PRD-approved tables exist.
  - `threads` and `pending_approvals` support M1 flows.
  - conversation bodies, tool calls, diffs, and approval histories are absent.
- Logging validation confirms:
  - structured stderr records are parseable JSON lines.
  - logs do not include token file contents, auth headers, user prompt bodies, assistant bodies, raw diffs, or tool arguments.
- Security boundary validation confirms:
  - codexclaw transports approvals but does not decide Codex sandbox policy.
  - no runtime command directly edits `AGENTS.md`.
  - Codex token remains read from configured token file and is not passed into channel messages or logs.
- Documentation validation confirms:
  - Bun commands are used.
  - M1 scope and non-goals are accurately described.

## Risks And Unknowns

- M0 findings are not yet recorded. M1 must not assume thread, turn, approval, fork, archive, or reconnect behavior beyond verified app-server behavior.
- Generated schemas include multiple protocol generations. M1 needs a clear choice of protocol surface based on M0 and schema pinning.
- Approval request/response may use JSON-RPC server-request mechanics that differ from the PRD conceptual names. The bridge should isolate this risk.
- Reconnect semantics may not allow proving whether an in-flight turn was accepted. The safe fallback is to avoid replay and quarantine or ask the user.
- `/branch` depends on verified thread fork support. If unsupported or unstable, command should return an explicit unsupported message in M1.
- Archive/unarchive/list/read behavior may be incomplete in M0. M1 should degrade to store-level status plus user guidance instead of faking Codex state.
- Bun SQLite may be sufficient, but implementation should confirm test ergonomics and deployment compatibility before relying on it everywhere.
- Structured logging can accidentally leak prompt or diff content if raw event payloads are logged. Event logging should whitelist fields.
- Keeping core code near the PRD 2,000 LoC target requires avoiding adapter-specific branching in runtime modules.
- Tests with a mock app-server can miss real app-server timing issues. A separate manual smoke path should remain available.

## Review History

| Round | Reviewer | Date | Findings | Resolution |
| --- | --- | --- | --- | --- |
| 1 | implementation-reviewer | 2026-05-01 | Active thread state, turn queueing, approval timeout/queueing, and idempotency key requirements were underspecified. | Updated plan to add active marker decision point, deterministic turn queueing, approval auto-reject/Modify timeout/one-active-approval queueing, and idempotency key gate/fallback. |
| 2 | implementation-reviewer | 2026-05-01 | `/archive` could break the active-thread invariant; approval response ingress was underspecified; Modify follow-up lacked context/queue semantics; Codex approval response type allowed `modify`. | Added archive fallback/blocking rules, channel approval response sketch, Modify context prefix and queue path, and narrowed Codex approval wire decision to approve/reject. |
| 3 | implementation-reviewer | 2026-05-01 | Turn guard pseudocode still allowed rejection despite the M1 queue policy. | Updated turn guard pseudocode to enqueue concurrent same-thread messages and acknowledge queueing. |
| 4 | implementation-reviewer | 2026-05-01 | Approval wire decision literals used `approve`/`reject`, but the PRD maps Codex responses to `approved`/`rejected`. | Updated the Codex approval wire decision sketch to `approved`/`rejected`. |
| 5 | implementation-reviewer | 2026-05-01 | No valid issues remain. | Plan workflow complete. |
