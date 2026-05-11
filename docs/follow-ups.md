# Follow-ups

This document tracks implementation improvements found during manual smoke
testing. Items here are not release blockers unless a release checklist promotes
them.

## 2026-05-12: Clarify Unverified Active Thread Routing Error

Status: fixed in working tree

During Docker/Apple Container smoke testing, a remote-channel message hit this
routing error:

```text
Thread 'default' is active; create /thread new or explicitly recover an archived label with /thread switch.
```

The message is confusing because `active` reads like a valid state. What it
really means is:

- codexclaw's pointer store still has label `default` marked as `active`
- the connected `codex app-server` could not verify that thread as routable
- this is common in isolated container smoke environments where the container's
  Codex auth/storage does not know host-side or previous smoke thread IDs

The user-facing error now distinguishes the local pointer status from the
app-server verification result.

Suggested wording:

```text
Thread 'default' is locally active but could not be verified in the connected Codex app-server. Create /thread new, or use /thread switch only when recovering a verified archived label.
```

Implementation notes:

- Current message is produced by `notRoutable` in `src/runtime/thread-sync.ts`.
- `assertThreadRoutable` passes through local `record.status` when
  `readObservedThreadState` returns `unknown`, which can produce
  `Thread 'default' is active`.
- Preserve the existing fail-closed behavior for ambiguous, partial, missing,
  and cwd-mismatched verification.
- Allow complete list scans that omit a `thread/read` verified active thread.
  Docker smoke testing showed `thread/start` and `thread/read` can succeed while
  `thread/list` remains empty.
- Added tests for the unlisted read-verified active path and the `unknown`
  observed-state wording path.
