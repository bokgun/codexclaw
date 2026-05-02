# M2 Telegram Review Checklist

Use this checklist when reviewing M2 implementation changes before release or
before accepting a follow-up patch. This is a review checklist, not the runtime
smoke-test checklist.

## Baseline

- `bun run typecheck` passes.
- `bun test` passes.
- `bun run schema:verify` passes, or any schema gate warning is understood and
  does not change generated schemas.
- Test files live under `test/` only.
- `git status --short` shows only the intended M2 review changes.

## Scope Fit

- Telegram is implemented as a channel adapter over the existing M1 runtime,
  router, approval bridge, and pointer store.
- The implementation does not duplicate Codex conversation, rollout, patch,
  model-routing, or approval storage.
- Group, supergroup, and channel chats are rejected in M2.
- Unsupported Telegram update types do not reach the router.
- Slash commands are passed as text to the shared router instead of being
  reimplemented in Telegram-specific code.
- `/quit` and `/exit` remain CLI-only host controls.

## Persistence Boundary

- Pointer store changes contain only codexclaw domain metadata:
  thread pointers, lifecycle timestamps, pending approval mappings, and prefs.
- No conversation bodies, Telegram message text, tool calls, diffs, callback
  payload histories, or approval histories are persisted.
- Branch suggestion held messages are in memory only and are cleared by TTL.
- Telegram update offsets and callback correlation maps are in memory only.

## Telegram Identity And Routing

- Allowed Telegram user IDs are numeric and fail closed when not configured.
- Unauthorized users are rejected before any router event is emitted.
- `userKey`, `channelThreadKey`, and `channelMessageId` are normalized
  consistently as Telegram-scoped identifiers.
- Approval and branch callbacks verify user, chat, and prompt message identity
  before emitting a channel response.
- Modify reply correlation is scoped by chat plus prompt message ID, not message
  ID alone.

## Approval And Modify Flow

- Approve and Reject callbacks resolve only the matching pending Codex approval.
- Expired approval callbacks answer as expired and do not emit approval
  responses.
- Modify selection immediately rejects the original Codex approval through the
  core bridge, then waits for a reply in memory.
- Modify replies before the Modify TTL enqueue exactly one follow-up turn.
- Blank Modify replies are rejected with a user-visible prompt and are not
  routed as normal messages.
- Late Modify replies after adapter timeout are ignored with a user-visible
  message and are not routed as normal messages.
- Disconnect invalidation tombstones and notifies active approvals and pending
  Modify waits.

## Branch Suggestion Flow

- Branch suggestions are opt-in for runtimes and enabled for Telegram runtime.
- Generic `HostRuntime` construction with default options does not create branch
  suggestion behavior.
- Idle-thread messages held for branch choice are cleared when the TTL expires.
- Continue sets suppression metadata without storing the held message body.
- New thread routes `/new` before routing the held message.
- Expired or unknown branch callbacks do not route held text.

## Telegram Output Behavior

- Agent deltas are coalesced enough to avoid one Telegram message per token.
- Pending deltas flush before status messages and approval prompts.
- Long outbound text is chunked below Telegram message limits.
- Callback data contains only opaque keys and action names, never prompt text,
  commands, diffs, tokens, or Codex payload bodies.
- Telegram Bot API fetch-level errors and API errors redact bot tokens.

## Security Review

- codexclaw only transports approval decisions; it does not bypass or weaken
  Codex sandbox or approval policy.
- Bot tokens stay in host configuration and are not forwarded to Codex turns.
- Logs and thrown errors redact Telegram bot tokens.
- AGENTS.md is not directly edited through channel commands.
- Remote Telegram users cannot terminate the host process.
- Stale callbacks after restart answer as expired or unknown and do not route
  approvals or user text.

## Documentation

- README documents required Telegram environment variables and `bun run
  telegram`.
- `docs/M2-manual-checklist.md` covers human smoke testing in a real Telegram
  private chat.
- The M2 plan remains consistent with implementation behavior, especially
  long-polling limitations and in-memory correlation state.
