# M0 Findings

Status: blocked

## Environment

- Codex CLI version: `0.128.0` observed in `thread/started.thread.cliVersion`
- Node.js version:
- Transport: WebSocket JSON-RPC
- App-server URL: `ws://127.0.0.1:4500`

## Protocol Observations

Observed through `src/spike/cli-repl.ts` against a local app-server already listening on
`127.0.0.1:4500` on 2026-05-01:

- `initialize` request succeeds, followed by `initialized` notification from client.
- `thread/start` request succeeds.
- `thread/start` response contains a thread id; the spike currently accepts
  `thread_id`, `threadId`, or `thread.id`.
- `thread/started` notification is emitted with a `thread` object containing:
  - `id`
  - `forkedFromId`
  - `preview`
  - `ephemeral`
  - `modelProvider`
  - `createdAt`
  - `updatedAt`
  - `status`
  - `path`
  - `cwd`
  - `cliVersion`
  - `source`
  - `agentNickname`
  - `agentRole`
  - `gitInfo`
  - `name`
  - `turns`
- `remoteControl/status/changed` notification was observed with
  `{ "status": "disabled", "environmentId": null }`.
- `mcpServer/startupStatus/updated` notification was observed with startup status.

Generated schema observations, not yet confirmed by live approval/reconnect spikes:

- Client request methods include `thread/start`, `thread/resume`, `thread/fork`,
  `thread/archive`, `thread/unarchive`, `thread/list`, `thread/read`,
  `turn/start`, `turn/steer`, and `turn/interrupt`.
- Server notification methods include `item/agentMessage/delta`,
  `turn/diff/updated`, `turn/completed`, `error`, `thread/status/changed`,
  and `serverRequest/resolved`.
- Server request methods for approval-like flows include:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`
  - `item/tool/requestUserInput`
  - legacy `applyPatchApproval`
  - legacy `execCommandApproval`
- `TurnStartParams` has no generated idempotency-key field. M1 must avoid
  automatic replay after ambiguous reconnects unless live testing discovers
  another verified idempotency mechanism.
- Generated command/file approval response decisions use `accept` and `decline`,
  not the PRD sketch literals `approved` and `rejected`.

## Checklist

- [x] `initialize` succeeds.
- [x] `thread/start` succeeds.
- [ ] `turn/start` produces streamed output.
- [ ] Approval approve/reject round trip succeeds.
- [ ] Cancel/timeout behavior is understood.
- [ ] Reconnect resumes thread state without duplicate turn execution.

## Decisions

- M1 implementation is blocked until live `turn/start` streaming, approval
  response mechanics, cancel/timeout behavior, and reconnect behavior are
  observed.
- M1 cannot rely on client-side turn idempotency keys based on the current
  generated `TurnStartParams` schema.
- Approval bridge implementation must be based on the generated request-specific
  response shapes unless live testing proves a different generic approval
  response path.
