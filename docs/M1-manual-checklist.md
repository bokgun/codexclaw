# M1 Manual Verification Checklist

Use this checklist after `bun run typecheck`, `bun test`, and
`bun run schema:verify` pass. It validates the interactive CLI path that mock
tests cannot fully cover.

## Setup

1. Start Codex app-server:

   ```bash
   bun run start:codex
   ```

2. In another terminal, start codexclaw:

   ```bash
   bun run cli
   ```

3. Confirm the CLI shows:

   ```text
   codexclaw>
   ```

## Basic Turn Streaming

Enter:

```text
hi
```

Expected:

- `Turn started.` appears.
- Agent text streams as normal readable text, not one token per line.
- `Turn completed.` appears.
- The next `codexclaw>` prompt appears only after the turn completes.
- JSON info logs such as `approval_pending` or `approval_resolved` do not appear
  during normal successful operation.

## Thread Commands

Run:

```text
/threads
/new
/threads
/new work
/switch work
테스트 메시지야. 짧게 답해줘.
/new work
/switch missing
```

Expected:

- `/threads` lists known thread labels and marks the active one with `*`.
- `/new` without a label creates a new auto label instead of overwriting
  `default`.
- `/new work` creates and switches to `work`.
- `/switch work` routes later messages to the `work` thread.
- Duplicate `/new work` returns a clear error.
- `/switch missing` returns a clear not-found error.

## Approval Approve Flow

Enter a prompt that writes outside the repository:

```text
`/Users/bokgun/Desktop/approval-smoke2.txt` 파일을 새로 만들고, 내용은 정확히 `codexclaw approval smoke2`를 넣어줘. 저장소 내부 파일은 수정하지 마. 승인이 필요하면 approval을 요청해. 파일 생성이 끝나면 멈춰.
```

Expected:

- Codex requests approval before writing to Desktop.
- The CLI prints an approval prompt with numbered choices:

  ```text
  Choose: 1 approve, 2 reject, 3 <instruction> modify.
  ```

Enter:

```text
1
```

Expected:

- The request is approved.
- The CLI does not reopen a fresh prompt in the middle of the active turn.
- The agent response after approval remains readable, not split one token per
  line.
- `Turn completed.` appears.
- The file exists at `/Users/bokgun/Desktop/approval-smoke2.txt` with exactly:

  ```text
  codexclaw approval smoke2
  ```

## Approval Reject Flow

Enter a similar outside-repository write request with a different filename:

```text
`/Users/bokgun/Desktop/approval-reject-smoke.txt` 파일을 새로 만들고, 내용은 정확히 `codexclaw reject smoke`를 넣어줘. 저장소 내부 파일은 수정하지 마. 승인이 필요하면 approval을 요청해. 파일 생성이 끝나면 멈춰.
```

When approval appears, enter:

```text
2
```

Expected:

- The request is rejected.
- Codex does not create the Desktop file.
- The CLI returns to `codexclaw>` after the turn completes or fails cleanly.

## Approval Modify Flow

Enter an outside-repository write request:

```text
`/Users/bokgun/Desktop/approval-modify-smoke.txt` 파일을 새로 만들고, 내용은 정확히 `codexclaw modify smoke`를 넣어줘. 저장소 내부 파일은 수정하지 마. 승인이 필요하면 approval을 요청해. 파일 생성이 끝나면 멈춰.
```

When approval appears, enter:

```text
3 저장소 밖에는 쓰지 말고, 대신 현재 요청을 취소하고 무엇을 하려 했는지만 짧게 설명해줘.
```

Expected:

- The original approval is rejected.
- codexclaw queues a follow-up turn with the modified instruction.
- The Desktop file is not created.
- The follow-up response explains the intended action briefly.

## Reconnect Behavior

While `bun run cli` is open, stop the app-server process.

Expected:

- codexclaw marks the app-server disconnected.
- Pending approvals are invalidated.
- Ambiguous in-flight threads are quarantined.
- New normal messages are rejected with a clear disconnected message until
  reconnect succeeds.

Restart app-server:

```bash
bun run start:codex
```

Expected:

- codexclaw reconnects.
- Known active threads are resumed with `thread/read` plus `thread/resume`.
- A new message can be routed after reconnect.

## Capability-Limited Commands

Run:

```text
/branch copy
/archive work
```

Expected:

- Both commands fail with explicit capability errors until `thread/fork` and
  `thread/archive` are verified for the pinned app-server.
- Failed `/branch` does not create a new default thread as a side effect.
- Failed `/archive` does not remove the only default active thread.

## Persistence And Store Boundary

Restart `bun run cli`, then run:

```text
/threads
```

Expected:

- Known labels and the active thread pointer persist.
- codexclaw has not persisted conversation bodies, tool calls, diffs, or approval
  histories outside Codex rollout storage.
- Stored data is limited to thread pointers, labels, pending approval mappings,
  tasks, and prefs.

## Exit

Run:

```text
/quit
```

Expected:

- CLI exits cleanly.
- No reconnect loop continues after shutdown.
