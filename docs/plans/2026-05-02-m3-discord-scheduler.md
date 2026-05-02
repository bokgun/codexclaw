# M3 Discord And Scheduler Implementation Plan

## Goal

Ship Discord personal mode and safe scheduled automation for codexclaw while
preserving the M1/M2 thin-host boundary. M3 adds a Discord adapter keyed by
`user_key`, a scheduler that injects tasks through the existing Router, and
whitelisted user preferences stored in `prefs`.

M3 must not add shared Discord thread semantics, duplicate Codex conversation
storage, weaken Codex sandbox or approval policy, or turn codexclaw into a
general job runner.

## PRD References

- PRD §3.1 Goals: remote channel routing, streaming output, approval bridge,
  user-level threads, pointer-only persistence.
- PRD §3.2 Non-goals: no Codex Cloud, no Slack stable channel, no shared
  team-thread model, no channel-driven AGENTS.md direct edits.
- PRD §4 P2: Discord server usage still routes by sender identity.
- PRD §5.2: inbound channel -> router -> Codex -> outbound channel flow.
- PRD §7.1-§7.2: Discord as a v1 channel and the adapter contract.
- PRD §8.1: codexclaw stores thread pointers, pending approvals, tasks, and
  prefs only.
- PRD §8.2: Scheduler retry, timeout, dedupe, and 5 consecutive failures
  disablement.
- PRD §8.3: three-way approval bridge; Discord buttons and Modify modal.
- PRD §8.4: task-bound named threads and user-scoped thread lifecycle.
- PRD §8.5: whitelisted `prefs` and AGENTS.md trust-boundary policy.
- PRD §9: Discord interaction signature verification, approval routing, token
  handling, prompt-injection boundaries.
- PRD §12 M3 and ROADMAP M3: Discord personal mode, Scheduler, and prefs KV.
- PRD §14 D4/D5: scheduler control requirements and Discord personal-mode
  stable decision.

## Scope

- Add a Discord channel adapter implementing the existing `ChannelAdapter`
  contract.
- Support Discord personal mode in DMs and shared servers, always keyed by
  sender `user_key`.
- Support Discord text inbound from DMs and bot mentions in guild channels,
  subject to Discord message-content availability.
- Use HTTP interactions as the trusted path for Discord slash commands,
  component clicks, modal submissions, approval decisions, and branch suggestion
  decisions. Verify Discord interaction signatures before any such payload is
  parsed or trusted.
- Normalize Discord messages and mentions into existing M1/M2 channel messages.
- Format outbound text, streamed deltas, approvals, and branch suggestions for
  Discord.
- Implement approval buttons for Approve, Reject, and Modify.
- Implement Modify through a Discord modal and hand the result to the existing
  Approval Bridge Modify path.
- Add Discord runtime entrypoint and configuration.
- Keep M3 HostRuntime single-channel. Scheduler tasks may run only on the
  channel served by the current process; cross-channel task dispatch requires a
  later channel registry/mux design.
- Extend the pointer store `tasks` table to the full PRD scheduler shape.
- Add a scheduler coordinator that triggers tasks as synthetic inbound messages
  through the existing Router.
- Enforce scheduler retry, timeout, dedupe with concurrency 1, final failure
  reporting, and disablement after 5 consecutive failures.
- Bind scheduled tasks to named thread labels so they do not use the default
  thread unless explicitly configured.
- Add whitelisted `/prefs show`, `/prefs set <key> <value>`, and
  `/prefs unset <key>` commands.
- Attach sanitized prefs to turn input as user preference context without
  changing sandbox, approval, or system authority.
- Add tests and manual validation checklist for Discord, scheduler, and prefs.

## Non-goals

- Shared Discord team/community thread semantics.
- Slack stable support.
- Multi-tenant SaaS behavior.
- Budget controls or token accounting.
- General background job execution outside the Codex Router path.
- Persistent storage of schedule run bodies, Codex responses, tool calls, diffs,
  approval histories, or Discord message content.
- Discord file upload, voice, attachment, embed-rich command workflows, or
  channel administration features.
- AGENTS.md direct edits through Discord or scheduler tasks.
- Web dashboard or full GUI for task management.

## Ordered Tasks

1. Configuration boundary for Discord and Scheduler
   - Dependencies: existing `src/config/env.ts`.
   - Add Discord config loading for bot token, application ID, public key,
     allowed user IDs, optional allowed guild IDs, API base URL, optional
     Gateway URL override for inbound text tests, HTTP interaction endpoint
     settings, delta flush timing, and Modify timeout.
   - Add scheduler config for enablement, tick interval, default retry,
     default timeout, default failure threshold, and clock injection for tests.
   - Fail closed when Discord token, application ID, or public key is missing.
   - Redact Discord tokens, bot authorization headers, and interaction URLs in
     logs and thrown errors.
   - Keep Discord credentials in host config only; never send them to Codex.

2. Discord API and interaction boundary
   - Dependencies: task 1.
   - Add a small Discord API client interface around Bun `fetch` for sending,
     editing, and acknowledging interactions.
   - Add an HTTP interaction receiver boundary for commands, components, and
     modals. It must verify Ed25519 signatures over the raw request body before
     parsing JSON.
   - Add a Gateway client boundary only for inbound message events if M3 chooses
     Gateway for DM/mention text. Gateway events must not be accepted as command,
     approval, component, modal, or branch-suggestion decisions.
   - Keep network-facing HTTP concerns separate from routing, approval, and
     scheduler logic.
   - Provide an in-memory/test receiver so adapter tests do not require network
     or a public Discord endpoint.

3. Discord adapter skeleton
   - Dependencies: tasks 1 and 2, existing `ChannelAdapter`.
   - Add `DiscordChannelAdapter` with `receive`, `approvalResponses`,
     `branchSuggestionResponses`, `send`, `requestApproval`,
     `requestBranchSuggestion`, `acknowledge`, `flushDeltas`, and `close`.
   - Isolate adapter-local correlation state for interaction callback keys and
     modal submissions.
   - Ensure `close` stops polling/listening and resolves async queues.

4. Discord inbound normalization
   - Dependencies: task 3.
   - Map Discord users to `userKey = discord:<user-id>`.
   - Map messages to `id = discord:<channel-id>:<message-id>`.
   - Use `channelThreadKey = discord:<channel-id>` for routing target binding,
     not for shared thread ownership.
   - Route DMs and valid bot mentions in guild channels.
   - Reject or ignore unmentioned guild chatter by default.
   - Reject unauthorized users or guilds before emitting router messages.
   - Treat Gateway/DM/mention text as normal Codex prompt text only.
   - Do not pass text that starts with `/` from Discord Gateway messages into
     executable Router command handling. Reply with a bounded notice directing
     the user to the signed Discord slash-command UI.
   - Allow executable Discord `/tasks`, `/prefs`, and thread lifecycle commands
     only through signed HTTP interactions.
   - Preserve enough reply/message IDs for Modify, branch suggestions, and
     user-facing replies without storing message bodies.

5. Discord outbound formatting and streaming
   - Dependencies: task 3.
   - Map outbound text/status events to Discord messages.
   - Coalesce `agent_delta` chunks per channel target to avoid one Discord
     message per token.
   - Flush pending deltas before status messages, approval prompts, or branch
     suggestions.
   - Respect Discord message length limits with deterministic chunking.
   - Prefer plain text unless Markdown escaping is covered by tests.
   - Do not persist outbound message bodies in codexclaw storage.

6. Discord approval prompt and Modify modal
   - Dependencies: tasks 3-5 and existing Approval Bridge Modify state.
   - Render approval prompts with message component buttons:
     - Approve
     - Reject
     - Modify
   - Use opaque callback keys that do not embed prompt text, diffs, tokens,
     commands, or raw Codex payloads.
   - Verify signature, user, channel, message, and pending approval state before
     emitting a channel approval response.
   - On Modify, open a modal for modified instructions and submit the modal text
     to the existing core Modify completion path.
   - Treat expired, unknown, wrong-user, or wrong-channel interactions as safe
     no-ops with a user-visible ephemeral response.

7. Discord branch suggestion UI
   - Dependencies: task 3 and existing `BranchSuggestionCoordinator`.
   - Render M2 branch suggestion events with Discord buttons:
     - New thread
     - Continue
   - Verify signature, same user, same target channel, and live suggestion state.
   - Keep held original messages in core memory only for the suggestion TTL.
   - Reject stale branch callbacks without routing stale text.

8. Discord runtime entrypoint and integration
   - Dependencies: tasks 1-7.
   - Add a Discord runtime entrypoint using `HostRuntime({ channel })`.
   - Add package scripts for running Discord mode.
   - Ensure reconnect, approval invalidation, one-active-turn queueing,
     branch suggestions, and pointer store reuse remain owned by M1/M2 core.
   - Keep CLI and Telegram runtime behavior unchanged.
   - Expose the runtime channel kind to Scheduler so M3 can reject or ignore
     tasks whose stored `channel` is not served by this HostRuntime process.

9. Task store schema and scheduler domain types
   - Dependencies: existing `PointerStore`.
   - Migrate `tasks` to include:
     - task id
     - schedule
     - prompt
     - user key
     - thread label
     - channel
     - enabled flag
     - retry
     - timeout seconds
     - dedupe policy
     - last run timestamp
     - last run status
     - consecutive failure count
     - next run timestamp if needed by the selected scheduler engine
   - Add store APIs for task CRUD, due task listing, run start, run success,
     run failure, skip due to dedupe, and disable after failure threshold.
   - Store only task definitions and run status metadata, not prompt outputs or
     Codex response bodies.

10. Schedule parsing and task command surface
    - Dependencies: task 9.
   - Add a minimal task command set:
      - `/tasks add <schedule> <label> <prompt>`
      - `/tasks list`
      - `/tasks pause <id>`
      - `/tasks reactivate <id>`
      - `/tasks remove <id>`
    - Validate cron or interval syntax before saving.
    - Require an explicit thread label or create a task-owned label using the
      existing Thread Manager path.
    - Reject schedules that would violate configured minimum interval.
    - Keep command parsing channel-neutral so CLI, Telegram, and Discord share
      the same behavior.
    - Treat `src/channel/commands.ts` as syntax parsing only. Add executable
      command handling in Router or a small Router-owned task/prefs command
      service, matching the current command execution path.
    - On task creation, set `task.channel` to the current runtime channel by
      default and reject explicit channels that do not match the current runtime
      channel in M3.

11. Scheduler coordinator
    - Dependencies: tasks 9 and 10, existing `Router` and `TurnQueue`.
   - Add a scheduler loop that finds due enabled tasks and injects synthetic
     `InboundMessage` values into Router.
   - Use `channel = task.channel`, but in M3 only execute tasks whose channel
     matches the current HostRuntime channel adapter.
   - Reject or mark skipped-visible tasks for other channels rather than trying
     cross-channel dispatch.
   - Use `userKey` and `label` to route to the task-bound named thread.
   - For Discord scheduled notices inside Discord runtime, derive a DM target
     from `discord:<user-id>` when no live channel target exists rather than
     storing interaction tokens or message bodies.
    - Enforce dedupe with concurrency 1 per task: if a previous run is active,
      skip the new trigger and do not queue it.
    - On timeout, attempt Codex turn cancel through the existing runtime client
      path and record whether cancellation succeeded.
    - On retryable failure, schedule bounded backoff attempts.
    - On final failure, notify the user once and increment consecutive failures.
    - Disable a task after 5 consecutive failures and tell the user how to
      reactivate it.

12. Scheduler and HostRuntime integration
    - Dependencies: task 11.
    - Add optional scheduler startup to HostRuntime when enabled.
    - Ensure HostRuntime shutdown stops scheduler timers before closing store
      and channel resources.
   - Ensure reconnect blocks or defers scheduler-triggered runs while Codex is
     disconnected.
   - Ensure ambiguous in-flight scheduled turns follow the same quarantine and
     failure accounting behavior as user-initiated turns where possible.
   - Add a route option or scheduler-specific entry boundary that selects a
     named thread label without changing the user's active interactive thread
     unexpectedly.

13. Prefs store APIs and command parsing
    - Dependencies: existing `prefs` table and command parser.
    - Add whitelist validation for `lang`, `tone`, and `verbosity`.
    - Add `/prefs show`, `/prefs set <key> <value>`, and `/prefs unset <key>`.
    - Reject unknown keys and empty values.
    - Keep prefs user-scoped by `userKey`.
    - Do not allow prefs commands to change internal system columns or task
      behavior.

14. Prefs attachment to turns
    - Dependencies: task 13 and existing Router/Codex input boundary.
   - Load whitelisted prefs at turn start.
   - Attach prefs as a bounded user-preference context block.
   - Prefer a schema-supported per-turn instruction boundary only if it is
     verified against pinned app-server schemas; otherwise attach preferences as
     a clearly delimited text preface.
   - Escape command-like prefixes, system-token-like strings, and leading
     instruction markers so prefs are treated as data.
    - Do not let prefs alter Codex sandbox, approval settings, model routing, or
      channel authorization.
    - Add tests showing prompt-injection-like prefs remain inert text.

15. Documentation and manual checklist
    - Dependencies: tasks 1-14.
    - Add `docs/M3-manual-checklist.md`.
    - Document Discord setup, token/public-key handling, interaction endpoint
      expectations, allowed user/guild settings, and local development limits.
    - Document scheduler task commands and failure behavior.
    - Document prefs whitelist and AGENTS.md trust-boundary reminder.

16. Tests
    - Dependencies: tasks 2-15.
    - Add focused Bun tests for:
      - Discord signature verification and raw-body handling.
      - Discord user/guild authorization and personal-mode `userKey` mapping.
      - DM, mention, unmentioned guild message, and unauthorized message paths.
      - Outbound formatting, delta coalescing, chunking, and flushing.
      - Approval button approve/reject/modify paths.
      - Modify modal success, empty modal, timeout, stale modal, wrong user, and
        wrong channel.
      - Branch suggestion button verification and stale callback rejection.
      - Task schema migration and no forbidden content columns.
      - Schedule parsing, task CRUD, due listing, retry, timeout, dedupe skip,
        final failure, and 5-failure disablement.
      - Scheduler HostRuntime integration with a mock channel and mock Codex.
      - Prefs whitelist, show/set/unset, sanitization, and turn attachment.
      - Secret redaction for Discord config/API errors.
    - Required commands:
      - `bun run typecheck`
      - `bun test`
      - `bun run schema:verify`

## Dependencies

- M1 `HostRuntime`, `Router`, `ThreadManager`, `ApprovalBridge`,
  `PointerStore`, and channel contracts.
- M2 approval target binding, Modify wait state, and branch suggestion
  coordinator.
- Existing Codex runtime client support for turn start and turn cancellation.
- Discord API concepts: messages, interactions, components, modals, raw-body
  signature verification, ephemeral responses, and rate-limit responses.
- A scheduler parser or small schedule abstraction selected during
  implementation. If a dependency is added, keep it narrow and Bun-compatible.
- Bun `fetch`, timers, `AbortController`, and SQLite.

## Expected File Changes

- `src/channel/discord.ts`: Discord adapter, API client boundary, interaction
  receiver integration, normalization, formatting, approvals, modals, and
  branch suggestion handling.
- `src/channel/index.ts`: export Discord adapter.
- `src/config/env.ts`: Discord and scheduler config loading, validation, and
  secret redaction.
- `src/runtime/discord.ts`: Discord runtime entrypoint.
- `src/runtime/host.ts`: optional scheduler composition and shutdown wiring.
- `src/runtime/scheduler.ts`: scheduler coordinator, due-task loop, retry,
  timeout, dedupe, and failure accounting.
- `src/runtime/schedule.ts`: schedule parsing abstraction if it does not fit in
  scheduler.
- `src/runtime/router.ts`: executable `/tasks` and `/prefs` command handling,
  plus small task-label or prefs attachment hooks only if current Router cannot
  accept the needed metadata.
- `src/codex/input.ts`: bounded prefs context construction if this is the
  current turn input boundary.
- `src/store/pointer-store.ts`: task schema migration, task APIs, and prefs
  APIs.
- `src/channel/commands.ts`: `/tasks` and `/prefs` command parsing.
- `src/channel/types.ts` or `src/runtime/types.ts`: minimal Discord/scheduler
  neutral event/type sketches.
- `package.json`: Discord runtime script and optional narrow scheduler
  dependency.
- `test/channel/discord.test.ts`: Discord adapter tests.
- `test/runtime/scheduler.test.ts`: scheduler coordinator tests.
- `test/runtime/schedule.test.ts`: schedule parser tests if separate.
- `test/runtime/discord-runtime.test.ts`: HostRuntime wiring tests if useful.
- `test/store/pointer-store.test.ts`: task and prefs store tests.
- `test/channel/commands.test.ts`: tasks and prefs command parsing tests.
- `docs/M3-manual-checklist.md`: manual validation checklist.
- `README.md` or operations docs: Discord and scheduler setup notes.

## Type And Interface Sketches

```ts
type DiscordUserKey = `discord:${string}`;
type DiscordChannelThreadKey = `discord:${string}`;

interface DiscordConfigSketch {
  botToken: string;
  applicationId: string;
  publicKey: string;
  allowedUserIds: readonly string[];
  allowedGuildIds: readonly string[];
  apiBaseUrl: string;
  gatewayUrl?: string;
  inboundTextMode: "gateway" | "http_commands_only" | "test";
  interactions: "http_signed";
  modifyTtlMs: number;
  deltaFlushMs: number;
}

interface DiscordInteractionSketch {
  id: string;
  token: string;
  type: "application_command" | "message_component" | "modal_submit";
  userId: string;
  guildId?: string;
  channelId: string;
  messageId?: string;
  customId?: string;
  modalValues?: readonly { customId: string; value: string }[];
}

interface DiscordApprovalStateSketch {
  approvalId: string;
  opaqueKey: string;
  userKey: DiscordUserKey;
  channelId: string;
  promptMessageId: string;
  expiresAt: string;
  mode: "pending_buttons" | "awaiting_modal";
}

interface TaskRecordSketch {
  taskId: string;
  userKey: string;
  label: string;
  channel: "cli" | "telegram" | "discord";
  schedule: string;
  prompt: string;
  enabled: boolean;
  retry: number;
  timeoutSec: number;
  dedupePolicy: "concurrency_1";
  lastRunAt?: string;
  lastRunStatus?: "succeeded" | "failed" | "skipped_dedupe" | "timed_out";
  consecutiveFailures: number;
}

interface ScheduledRouteSketch {
  taskId: string;
  userKey: string;
  channel: "cli" | "telegram" | "discord";
  threadLabel: string;
  prompt: string;
  timeoutSec: number;
}

interface TaskRunStateSketch {
  taskId: string;
  attempt: number;
  startedAt: string;
  deadlineAt: string;
  status: "running" | "retry_wait" | "complete";
}

interface PrefRecordSketch {
  userKey: string;
  key: "lang" | "tone" | "verbosity";
  value: string;
  updatedAt: string;
}
```

## Pseudocode

Discord interaction verification:

```text
on raw interaction request:
  read timestamp, signature, and raw body
  verify signature with configured Discord public key
  if verification fails, reject before JSON parsing
  parse interaction
  if user or guild is unauthorized, return ephemeral denial
  if component custom_id matches approval:
    verify opaque key, user, channel, message, and expiry
    emit channel approval response or open Modify modal
  if modal custom_id matches Modify:
    verify opaque key, user, channel, message, and expiry
    emit modify approval response with modal text
  if component custom_id matches branch suggestion:
    verify opaque key, user, channel, and expiry
    emit branch suggestion response

on Gateway interaction-like event:
  ignore for commands, approvals, modals, and branch suggestions in M3
```

Discord inbound routing:

```text
on Discord message:
  ignore bot-authored messages
  if user or guild is not allowed, reject before routing
  if text starts with "/":
    send bounded notice to use signed Discord slash commands
    stop without Router command execution
  if DM:
    use full text
  else if guild message mentions the bot:
    strip only the bot mention wrapper
    use the remaining text
  else:
    ignore without routing
  emit NormalizedMessage with userKey discord:<user-id>
  set channelThreadKey to discord:<channel-id>
```

Scheduler tick:

```text
every scheduler tick:
  list due enabled tasks
  for each task:
    if task.channel does not match current runtime channel:
      skip with visible configuration error and continue
    if task has active run:
      record skipped_dedupe and continue
    start run attempt 1
    inject synthetic inbound message to Router with task userKey and label
    wait for success, failure, disconnect, or timeout signal
    if timeout:
      request turn cancel
      mark failed/timed_out
    if failure and attempts remain:
      wait bounded backoff and retry
    if final failure:
      increment consecutive failures
      notify configured channel once
      disable task when consecutive failures reaches threshold
    if success:
      reset consecutive failures and record last_run_status succeeded
```

Scheduled route target:

```text
route scheduled message:
  resolve configured thread label for user
  if label is archived, missing, or quarantined:
    fail task visibly
  enqueue turn through a scheduler route boundary
  do not switch the user's active interactive label unless the user explicitly configured that behavior
  enforce task timeout around the active run
```

Prefs turn attachment:

```text
before starting a user or scheduled turn:
  load prefs for message.userKey
  filter to lang, tone, verbosity
  sanitize values as data
  append bounded preference context to turn input
  do not change approval policy, sandbox policy, model, or transport config
```

Task command handling:

```text
on /tasks add schedule label prompt:
  validate schedule and label
  ensure label exists or create task-owned thread through Thread Manager policy
  save task with retry, timeout, dedupe defaults
  report task id and next run hint

on /tasks reactivate id:
  set enabled true and reset consecutive failure count
```

## Validation Criteria

- Invalid Discord config fails fast and redacts secrets.
- Discord interaction signatures are verified before JSON parsing or routing.
- Gateway-originated events are not trusted for commands, approvals, modals, or
  branch suggestions in M3.
- Discord Gateway/DM text that begins with `/` does not execute Router commands;
  executable Discord commands enter only through signed HTTP interactions.
- Discord personal mode always routes by sender `discord:<user-id>`, including
  in shared guild channels.
- Unmentioned guild messages and unauthorized users/guilds do not route.
- Discord approvals resolve only the bound pending approval and only from the
  bound user/channel/message.
- Discord Modify modal integrates with the existing reject-plus-follow-up Modify
  path.
- Discord branch suggestion callbacks cannot route stale or cross-user text.
- Discord outbound streaming is chunked, coalesced, flushed before prompts, and
  not persisted by codexclaw.
- Scheduler stores only task metadata and run status, not Codex outputs.
- Scheduler uses the same Router path as normal messages.
- Scheduler tasks run only when `task.channel` matches the current single
  HostRuntime channel.
- Scheduler enforces retry, timeout, dedupe with concurrency 1, final failure
  notice, and 5-consecutive-failure disablement.
- Timeout attempts turn cancel and records the result.
- Scheduled tasks bind to named thread labels and do not pollute default threads
  unless explicitly configured.
- Scheduled task routing does not unexpectedly change the user's active
  interactive thread.
- Prefs are limited to `lang`, `tone`, and `verbosity`.
- Prefs values are sanitized and cannot alter sandbox, approval policy, model
  routing, channel authorization, task controls, or AGENTS.md.
- `bun run typecheck`, `bun test`, and `bun run schema:verify` pass.
- Live M3 manual checklist passes with `bun run start:codex`, Discord runtime,
  and at least one scheduled task.

## Risks And Unknowns

- Discord interaction transport:
  - Risk: webhook mode needs a reachable HTTP endpoint, while the project has no
    general HTTP server yet.
  - Mitigation: keep receiver behind an interface and support a test/local
    receiver path; M3 uses signed HTTP interactions for trusted commands,
    approvals, components, modals, and branch suggestions. Gateway, if used, is
    limited to text message events.

- Discord message content availability:
  - Risk: guild message content may be unavailable without privileged Message
    Content Intent except in DMs and app mentions.
  - Mitigation: support DMs and mention-driven guild messages first, test both
    paths, and document required Discord application settings.

- Discord rate limits:
  - Risk: streamed Codex deltas can hit message or edit limits.
  - Mitigation: coalesce deltas, chunk deterministically, and back off on API
    rate-limit responses.

- Schedule parser dependency:
  - Risk: adding a broad cron library increases dependency surface.
  - Mitigation: choose a narrow Bun-compatible parser or a small schedule
    abstraction; keep task execution controls in codexclaw code.

- Timeout and cancel ambiguity:
  - Risk: Codex cancel can be non-deterministic after a scheduled task timeout.
  - Mitigation: record cancel result, follow existing quarantine behavior for
    ambiguous in-flight threads, and disable repeatedly failing tasks.

- Prefs prompt injection:
  - Risk: user-controlled prefs could try to smuggle instructions.
  - Mitigation: strict key whitelist, bounded value length, escaping, and tests
    for command-like or system-like values.

- M2 dependency coupling:
  - Risk: Discord plan assumes M2 Modify and branch suggestion core boundaries
    are present.
  - Mitigation: implement missing core pieces before Discord-specific UI and
    keep shared behavior channel-neutral.

- Scheduled task destination:
  - Risk: the PRD task schema stores `channel`, `user_key`, and `label`, but
    Discord user-visible failure notices require a concrete send target.
  - Mitigation: derive a DM target from the Discord user key where possible and
    only add persistent channel target metadata after an explicit storage-boundary
    decision.

- Single-channel runtime:
  - Risk: tasks store a `channel` field, but HostRuntime currently owns one
    `ChannelAdapter`.
  - Mitigation: M3 only executes tasks for the current runtime channel and
    rejects cross-channel task creation. A channel registry/mux is a separate
    post-M3 design.

## Review History

- 2026-05-02: Initial plan drafted.
- 2026-05-02: Planner review incorporated Gateway/HTTP delivery mode,
  message-content availability, scheduled route targeting, and prefs input
  boundary notes.
- 2026-05-02: Implementation review round 1 found Discord Gateway authenticity,
  scheduler single-channel dispatch, and command ownership gaps; plan updated to
  require signed HTTP interactions for trusted Discord actions, constrain M3
  scheduler to the active runtime channel, and place executable `/tasks` and
  `/prefs` handling on the Router-owned command path.
- 2026-05-02: Implementation review round 2 found remaining ambiguity around
  Discord Gateway slash-like text; plan updated so Discord text can route only
  as prompt text, while executable Discord commands require signed HTTP
  interactions.
