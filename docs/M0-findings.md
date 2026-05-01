# M0 Findings

Status: M0 runtime gate passed; Schema Gate blocked

M0 runtime behavior was observed against a local `codex app-server` on
2026-05-01. M1 runtime implementation is still blocked by the separate Schema
Gate until the generated schemas are tied to a pinned Codex CLI/app-server
version and regeneration provenance is recorded.

## Environment

- Codex CLI version: `codex-cli 0.128.0`
- Observed app-server thread `cliVersion`: `0.128.0`
- Bun version: `1.3.13`
- Node.js version: `v25.9.0`
- Transport: WebSocket JSON-RPC
- App-server URL: `ws://127.0.0.1:4500`

## Probe Commands

Repeatable M0 probe scripts:

- `bun run spike:turn`
- `bun run spike:diff-tool`
- `CODEXCLAW_APPROVAL_DECISION=accept CODEXCLAW_APPROVAL_PROMPT='<explicit command prompt>' bun run spike:approval`
- `CODEXCLAW_APPROVAL_DECISION=decline CODEXCLAW_APPROVAL_PROMPT='<explicit command prompt>' bun run spike:approval`
- `CODEXCLAW_APPROVAL_DECISION=accept CODEXCLAW_APPROVAL_PROMPT='<explicit file-change prompt>' bun run spike:approval`
- `CODEXCLAW_APPROVAL_DECISION=decline CODEXCLAW_APPROVAL_PROMPT='<explicit file-change prompt>' bun run spike:approval`
- `bun run spike:cancel`
- `bun run spike:reconnect`
- `bun run spike:pointer-store`

Probe logs summarize payload shape, method names, request ids, and event counts.
They do not intentionally persist conversation bodies, raw diffs, tool
arguments, or approval histories outside Codex rollout storage.

The live runtime probes fail non-zero when required observations are missing:
terminal turn events, approval server requests, interrupt turn ids, reconnect
follow-up completion, and pointer-store assertions are not treated as successful
timeouts.

## Protocol Observations

### JSON-RPC Transport

- `initialize` request succeeds, followed by `initialized` notification from the
  client.
- `thread/start` request succeeds.
- `thread/start` response contains `thread.id`.
- `thread/started` notification is emitted with a `thread` object containing
  thread metadata and an empty `turns` array.
- The client must classify inbound JSON-RPC messages as:
  - `response`: id with result or error and no method.
  - `notification`: method without id.
  - `server_request`: id with method.
- Server requests are answered by sending a JSON-RPC response with the same id.
- `remoteControl/status/changed` was observed with
  `{ status, environmentId }`.
- `mcpServer/startupStatus/updated` was observed with `{ name, status, error }`.

### Turn Streaming

`bun run spike:turn` passed.

Observed flow:

- `turn/start` params shape:
  - `threadId`
  - `input: [{ type: "text", text, text_elements: [] }]`
- `turn/start` response shape:
  - `{ turn: { id, items, status, error, startedAt, completedAt, durationMs } }`
- Turn id source:
  - `turn/start` response `turn.id`
  - `turn/started` notification `turn.id`
  - notification `turnId` fields
- Streaming events:
  - `thread/status/changed`
  - `turn/started`
  - `item/started`
  - `item/completed`
  - `item/agentMessage/delta`
  - `thread/tokenUsage/updated`
  - `turn/completed`
- Completion:
  - `turn/completed` includes `{ threadId, turn }`.
- Same-thread follow-up:
  - a second `turn/start` on the same thread completed successfully.

### Diff And Tool Events

`bun run spike:diff-tool` passed in a disposable temp workspace.

Observed diff/file events:

- `item/started` for file change items includes:
  - `item.type`
  - `item.id`
  - `item.changes[]`
  - `item.status`
- `item/fileChange/outputDelta` includes:
  - `threadId`
  - `turnId`
  - `itemId`
  - `delta`
- `turn/diff/updated` includes:
  - `threadId`
  - `turnId`
  - `diff`
- `item/completed` for file change items includes final status.

Observed command/tool events:

- `item/started` for command execution items includes:
  - `command`
  - `cwd`
  - `processId`
  - `source`
  - `status`
  - `commandActions`
  - `aggregatedOutput`
  - `exitCode`
  - `durationMs`
- `item/completed` carries final status, exit code, and can include
  `aggregatedOutput`.
- `item/commandExecution/outputDelta` was observed in earlier runs but was not
  emitted consistently for short commands; M1 should handle it opportunistically
  and rely on item completion state for final command status.
- Failed commands were observed with command item status `failed`.

M1 channel UX should summarize file paths, item status, exit code, and rough
diff/output size. It should not persist or replay raw diffs, command strings, or
tool output bodies from codexclaw storage.

### Approval Requests

Approval server requests are JSON-RPC requests with id and method.

The approval probe only auto-responds to the observed command and file-change
approval methods. It validates that the request belongs to the active thread,
has a string `itemId`, and matches the active turn id when the turn id is known.
Unobserved approval families are left unanswered so the probe fails closed
instead of inventing a response shape.

Observed methods:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`

Observed command approval params shape:

- `threadId`
- `turnId`
- `itemId`
- `reason`
- `command`
- `cwd`
- `commandActions`
- `proposedExecpolicyAmendment`
- `availableDecisions`

Observed file-change approval params shape:

- `threadId`
- `turnId`
- `itemId`
- `reason`
- `grantRoot`

Observed response mapping:

- `item/commandExecution/requestApproval` approve:
  - response `{ decision: "accept" }`
  - server emits `serverRequest/resolved`
  - command item proceeds and turn completes.
- `item/commandExecution/requestApproval` reject:
  - response `{ decision: "decline" }`
  - server emits `serverRequest/resolved`
  - command item status becomes denied and Codex continues safely.
- `item/fileChange/requestApproval` approve:
  - response `{ decision: "accept" }`
  - server emits `serverRequest/resolved`
  - `item/fileChange/outputDelta`, `turn/diff/updated`, and `turn/completed`
    follow.
- `item/fileChange/requestApproval` reject:
  - response `{ decision: "decline" }`
  - server emits `serverRequest/resolved`
  - file change item status becomes denied and Codex continues safely.

Not observed live:

- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- legacy `applyPatchApproval`
- legacy `execCommandApproval`

A network-oriented command prompt was attempted; the live app-server emitted
`item/commandExecution/requestApproval` for the requested command, not
`item/permissions/requestApproval`.

Generated schema notes for unobserved families:

- `item/permissions/requestApproval` response shape is
  `{ permissions, scope, strictAutoReview? }`; it does not expose a simple
  `decline` literal in the generated response type.
- legacy approval response shapes use `ReviewDecision` values such as
  `approved`, `denied`, `timed_out`, and `abort`.

M1 should implement observed command/file approval first and keep explicit
capability handling for unobserved approval families.

### Modify Feasibility

M0 did not implement production Modify UX.

The observed approval rejection behavior supports the PRD premise that Modify
can be modeled as:

1. reject the original approval request with the request-specific reject shape.
2. enqueue a follow-up `turn/start` containing the corrected user instruction
   and enough original action context for Codex to retry.

M1 must avoid storing approval history or raw tool payloads while carrying only
the short-lived context needed for the follow-up turn.

### Cancel And Timeout

`bun run spike:cancel` passed after using a long-running `sleep 30` command.

Observed behavior:

- Turn id was available from `turn/started` notification.
- The probe waits for the `sleep 30` command item to start before interrupting.
- `turn/interrupt` params are `{ threadId, turnId }`.
- `turn/interrupt` response was `{}`.
- Server emitted `turn/completed` after interrupt; the turn status shape summary
  showed a distinct status length from successful turns, consistent with an
  interrupted terminal state.
- The interrupted turn completed quickly after interrupt, and the probe fails if
  it observes the sleep command complete naturally with exit code `0`.
- `thread/read` with `{ threadId, includeTurns: false }` succeeded after
  interrupt.
- A safe follow-up `turn/start` on the same thread completed successfully.

M1 timeout behavior can call `turn/interrupt` when a turn id is known. If no
turn id is known or interrupt fails, M1 should not assume the thread is safe;
that path should map to quarantined or blocked routing until the user chooses a
recovery path.

### Reconnect And Resume

`bun run spike:reconnect` passed after adding explicit `thread/resume`.

Observed behavior:

- The client closes the WebSocket mid-turn and reconnects.
- `initialize` must be repeated on the new WebSocket connection.
- `thread/read` with `{ threadId, includeTurns: false }` returns current thread
  metadata and status after reconnect.
- `thread/read` with `{ threadId, includeTurns: true }` can summarize the
  original turn state; in the passing reconnect run the original target turn was
  still reported in progress when the client reconnected.
- `thread/read` alone did not restore streaming subscriptions for a follow-up
  turn in the first reconnect probe.
- `thread/resume` with `{ threadId, excludeTurns: true }` restored the thread
  enough for a follow-up `turn/start` to stream and complete.
- Missed deltas from the disconnected interval were not proven to replay.
- The original prompt was not automatically replayed.

M1 reconnect rule:

- reconnect and initialize.
- read thread state.
- resume the thread before routing more work.
- do not automatically replay an in-flight prompt unless app-server acceptance
  state is known.
- if state is ambiguous, block or quarantine rather than duplicate execution.

### Pointer Store Minimum

`bun run spike:pointer-store` passed against a temporary Bun SQLite database.

Validated only the M0-level schema assumptions:

- `(user_key, label) -> thread_id` storage and lookup.
- `is_default` flag.
- `status` values `active` and `archived`.
- `last_routed_at` stores an activity timestamp.
- `suppress_branch_until` defaults to `NULL`.

This is not the M1 pointer-store implementation. M1 still needs migrations,
pending approvals, task and prefs placeholders, active-label invariant, and
tests.

## Schema Gate

Blocked.

Observed runtime and local CLI report Codex CLI/app-server version `0.128.0`,
but the repository does not yet record a pinned Codex version in `package.json`,
Dockerfile, or another schema provenance file. The current
`schemas/generated/**` contents are checked in, but the exact generation command
and source binary pin are not recorded.

M1 implementation must not proceed until Schema Gate is satisfied or explicitly
waived by a follow-up plan/review.

## Checklist

- [x] `initialize` succeeds.
- [x] `thread/start` succeeds.
- [x] `turn/start` produces streamed output.
- [x] Approval approve/reject round trip succeeds.
- [x] Cancel/timeout behavior is understood.
- [x] Reconnect resumes thread state without duplicate turn execution.

## Decisions

- M0 runtime gate passes for WebSocket, thread, turn streaming, command/file
  approval, cancel/interrupt, reconnect/resume, and minimal pointer-store
  assumptions.
- Schema Gate remains blocked because generated schema provenance and Codex
  version pinning are not recorded.
- M1 cannot rely on client-side turn idempotency keys based on the current
  generated `TurnStartParams` schema.
- M1 must avoid automatic prompt replay after ambiguous reconnects.
- M1 must call `thread/resume` after reconnect before routing additional turns.
- Approval bridge implementation must use request-specific response shapes:
  command/file approvals use `accept` and `decline`, while unobserved approval
  families need explicit capability handling.
- Modify remains reject plus follow-up turn; it must not mutate Codex approval
  policy and must not persist approval history.
