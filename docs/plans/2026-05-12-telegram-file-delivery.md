# Telegram File Delivery Plan

## Goal

Add safe, host-layer outbound document delivery for Telegram after a Codex turn
when the user explicitly asked for a file to be sent. codexclaw must not give
Codex Telegram credentials or tools, persist conversation/tool/diff/approval
content, or expand M2 into general Telegram uploads and rich attachment
workflows.

## PRD References

- PRD section 3.1: stream Codex results back through channels while keeping
  codexclaw as a thin host, router, and memory layer.
- PRD section 3.2: do not reimplement Codex behavior or allow channel-driven
  direct edits of `AGENTS.md`.
- PRD section 5.2: Codex notifications are translated into outbound channel
  messages by codexclaw.
- PRD section 7.2: channel adapters expose `send(text, attachments)`.
- PRD section 8.1: codexclaw persists only thread pointers, labels, schedules,
  pending approval mappings, and prefs; Codex rollout remains the source of
  truth for content, tool calls, diffs, and approval history.
- PRD section 9: channel credentials stay in the host boundary and must not be
  exposed to Codex.
- `docs/M0-findings.md`: app-server emits file-change and diff events, but
  runtime code currently summarizes them and must not persist raw diffs or tool
  bodies.
- `docs/plans/2026-05-01-m2-telegram-channel.md`: Telegram file uploads and
  rich attachments were out of M2 scope. This plan is a bounded outbound-only
  follow-up.

## Scope

- Add a channel-neutral outbound attachment shape for local documents/files.
- Add a host-layer file delivery coordinator that collects candidate local paths
  during a turn and attempts delivery only after terminal turn events.
- Gate delivery on explicit in-memory user intent for the current turn, such as
  asking Codex to send, attach, upload, or deliver a file. Normal answers that
  merely mention paths must not trigger Telegram uploads.
- Exclude scheduler-originated turns from this plan. Scheduled Telegram tasks
  are unattended and may contain persisted prompts, so file delivery for
  scheduler output needs a separate task-level opt-in design.
- Derive candidates from explicit assistant output paths first, and from
  structured runtime metadata only if the pinned app-server exposes path
  metadata without raw body persistence.
- Validate paths against configured allowed roots, defaulting to
  `CODEXCLAW_WORKSPACE_ROOT`.
- Send valid files through Telegram Bot API `sendDocument`.
- Preserve text fallback behavior when files are invalid, too large, missing,
  unsupported, or channel delivery fails.
- Add tests for intent gating, path extraction, root validation, symlink
  handling, size limits, Telegram API redaction, and event-to-send flow.
- Add README and manual checklist updates for Telegram document delivery.

## Non-goals

- No Telegram inbound file uploads.
- No image, video, audio, sticker, or media-specific Telegram handling.
- No Bot API access, bot token, or Telegram tool exposed to Codex.
- No persistence of assistant messages, user messages, file contents, tool
  calls, raw diffs, raw file-change deltas, approval histories, or delivered
  file history.
- No automatic delivery of arbitrary files mentioned by user or assistant text
  outside an explicitly file-delivery-intended turn.
- No document delivery for scheduled tasks or other unattended routes.
- No uploading files outside configured allowed roots.
- No new database tables for artifacts.
- No direct `AGENTS.md` edits through channel commands.
- No general artifact browser, file listing UI, or multi-channel rich attachment
  framework beyond the small channel-neutral boundary needed here.

## Ordered Tasks

1. Define the file delivery policy boundary.
   - Dependencies: PRD, runtime path config, `src/config/env.ts`.
   - Add a small runtime config concept for outbound file delivery.
   - Config names:
     - `CODEXCLAW_TELEGRAM_FILE_DELIVERY_ENABLED`
     - `CODEXCLAW_FILE_DELIVERY_ALLOWED_ROOTS`
     - `CODEXCLAW_FILE_DELIVERY_MAX_BYTES`
     - `CODEXCLAW_FILE_DELIVERY_MAX_FILES`
   - Defaults: default-off with
     `CODEXCLAW_TELEGRAM_FILE_DELIVERY_ENABLED=false`, allowed roots default to
     `CODEXCLAW_WORKSPACE_ROOT` when enabled, max document size stays below
     Telegram Bot API limits, and max files per turn is small.
   - Treat state dir, token file, database file, Codex rollout/session paths,
     `.git`, and symlink escapes as non-deliverable even if they sit under a
     local-dev workspace.
   - Validation: unsafe roots are rejected, default roots align with workspace
     boundaries, sensitive paths are denied, and typecheck passes.

2. Add current-turn file delivery intent detection.
   - Dependencies: `src/runtime/router.ts`, `src/runtime/host.ts`, and channel
     input normalization.
   - Capture only a bounded, non-persisted boolean/classification for the active
     turn before routing to Codex.
   - Recognize explicit delivery verbs and file nouns in the inbound message;
     reject vague path mentions as non-delivery intent.
   - Source the intent only from live user-originated Telegram messages. Do not
     infer file delivery intent from scheduler prompts, task records, recovered
     persisted data, or assistant output alone.
   - Keep this as in-memory turn metadata only; do not write user text or the
     derived intent to SQLite.
   - Validation: tests prove ordinary answers mentioning paths do not upload
     files, explicit "send/upload/attach this generated file" turns can enter
     the delivery path, and `routeScheduled` cannot emit `document_delivery`.

3. Sketch channel-neutral attachment types.
   - Dependencies: task 1, `src/channel/types.ts`, `src/runtime/types.ts`.
   - Extend outbound attachment/event shapes with a local document attachment.
   - Keep the shape metadata-only: path, optional display filename, size,
     content type hint, and failure fallback text.
   - Do not include file bytes in runtime events or stored records.

   Type/interface sketch:

   ```ts
   type OutboundAttachment =
     | ExistingAttachmentKinds
     | {
         kind: "local_document";
         path: string;
         displayName?: string;
         sizeBytes?: number;
         contentType?: string;
       };

   type OutboundEvent =
     | ExistingOutboundEvents
     | {
         kind: "document_delivery";
         channel: ChannelName;
         userKey: UserKey;
         text: string;
         documents: readonly LocalDocumentRef[];
         channelThreadKey?: string;
       };

   interface LocalDocumentRef {
     absolutePath: string;
     displayName: string;
     sizeBytes: number;
     source: "assistant_path" | "runtime_file_metadata";
   }
   ```

   Validation: existing CLI, Discord, and Telegram send tests still compile;
   unsupported adapters render fallback text rather than uploading.

4. Add safe path extraction and validation service.
   - Dependencies: task 1.
   - Add a small module for candidate extraction and validation.
   - Extract only explicit local path references from assistant output, such as
     absolute paths under the workspace or clearly relative paths with file
     extensions.
   - Ignore vague phrases, URLs, shell fragments, command substitutions, and
     paths from user input that Codex did not produce in the turn.
   - Normalize and realpath candidates before delivery.
   - Require existing regular files.
   - Reject directories, symlinks that escape allowed roots, files over limit,
     denied path segments, sensitive host paths, and duplicates.
   - Require just-in-time validation in the upload path, or carry a verified
     file handle/blob that was opened after validation and is not reopened by
     path later. The implementation must not validate a path and then upload a
     different filesystem object after a symlink or file swap.
   - Return sanitized rejection reasons for logs and user fallback text.

   Type/interface sketch:

   ```ts
   interface FileDeliveryPolicy {
     enabled: boolean;
     allowedRoots: readonly string[];
     deniedRoots: readonly string[];
     deniedSegments: readonly string[];
     maxFileBytes: number;
     maxFilesPerTurn: number;
   }

   interface CandidatePath {
     rawText: string;
     turnId?: TurnId;
     source: "assistant_path" | "runtime_file_metadata";
   }

   interface ValidationResult {
     accepted: readonly LocalDocumentRef[];
     rejected: readonly RejectedDocumentRef[];
   }

   interface RejectedDocumentRef {
     displayPath: string;
     reason:
       | "outside_allowed_roots"
       | "missing"
       | "not_regular_file"
       | "too_large"
       | "denied_path"
       | "symlink_escape"
       | "duplicate"
       | "limit_exceeded";
   }
   ```

   Validation: unit tests cover relative and absolute paths, `../` escapes,
   state/token/db/Codex rollout paths, `.git`, symlink escapes, missing files,
   directories, oversized files, duplicate mentions, and a symlink/file swap
   between initial validation and upload.

5. Capture candidate paths during a turn without persistence.
   - Dependencies: tasks 2-4, `src/runtime/events.ts`,
     `src/codex/runtime-client.ts`.
   - Add an in-memory per-turn candidate collector.
   - Feed it assistant deltas for bound Telegram turns only when current-turn
     delivery intent is true.
   - Optionally feed structured file metadata from file-change items if the
     runtime client can expose path summaries without storing raw diffs or
     content.
   - Clear collector state on turn completion, turn failure, disconnect
     quarantine, or host close.
   - Log only bounded counts and reason codes.

   Pseudocode:

   ```text
   on inbound Telegram message:
     classify file delivery intent in memory
     bind intent to the thread/turn once routing starts

   on scheduled or non-user-originated route:
     set file delivery intent to none

   on runtime event:
     resolve target by thread id
     if no target or target.channel is not telegram:
       keep existing behavior

     if event is agent_delta:
       send delta as today
       if current turn has delivery intent:
         extract bounded path candidates from delta text
         discard raw delta after candidate extraction

     if event is structured file metadata and current turn has delivery intent:
       add path candidates from structured path fields only

     if event is turn_completed or turn_failed:
       validate candidates for that turn
       if accepted documents exist:
         emit document_delivery outbound event
       if rejected files exist and no accepted files:
         emit bounded fallback text
       delete per-turn collector state
   ```

   Validation: dispatcher tests show chat channels still suppress routine
   diff/tool status; candidate state clears on terminal paths; no candidates are
   persisted to store; bounded buffers prevent unbounded memory growth.

6. Wire document delivery through `ChannelAdapterSink`.
   - Dependencies: tasks 3 and 5, `src/runtime/host.ts`.
   - Map `document_delivery` outbound events into `OutboundMessage` with
     `local_document` attachments.
   - Flush agent deltas before sending documents.
   - Preserve text fallback when the active channel does not support document
     attachments.

   Pseudocode:

   ```text
   when sink receives document_delivery:
     flush pending deltas
     if channel supports local_document attachment:
       send text plus local_document attachments
     else:
       send text fallback with safe display names only
   ```

   Validation: host/runtime tests verify document events reach Telegram adapter;
   approval and branch suggestion behavior remains unchanged.

7. Add Telegram `sendDocument` API boundary.
   - Dependencies: task 3, `src/channel/telegram.ts`.
   - Extend `TelegramApiClient` with `sendDocument`.
   - Implement Bot API multipart upload in `TelegramFetchApiClient`.
   - Keep bot token redaction behavior for `sendDocument` errors.
   - Prefer simple text plus documents over captions for predictable Telegram
     limits.
   - Revalidate the local document immediately before building the multipart
     upload, or accept only a previously verified in-memory file handle/blob
     from the delivery coordinator.
   - Preserve chunked text behavior for normal messages.

   Type/interface sketch:

   ```ts
   interface TelegramApiClient {
     existingMethods: ExistingMethods;
     sendDocument(params: TelegramSendDocumentParams): Promise<TelegramMessage>;
   }

   interface TelegramSendDocumentParams {
     chat_id: number | string;
     document: LocalFileUploadRef;
     caption?: string;
     reply_to_message_id?: number;
   }

   interface LocalFileUploadRef {
     path: string;
     filename: string;
     contentType?: string;
   }
   ```

   Validation: Telegram adapter tests verify `sendDocument` target chat and
   sanitized filename, oversized documents are not sent, per-turn file limits
   are respected, symlink/file swaps between validation and send are rejected,
   deltas flush before documents, and token-bearing failures are redacted.

8. Add fallback UX and logging rules.
   - Dependencies: tasks 4 and 7.
   - User-facing fallback says which files could not be sent using safe display
     names and bounded reason text.
   - Logs include counts, source kind, sizes, rejection reason codes, and
     channel/user/thread ids.
   - Logs must not include file contents, bot token, raw assistant body, raw user
     body, raw diffs, or tool output bodies.
   - Failed upload does not fail the turn or retry indefinitely.
   - Validation: log tests verify no token/content leakage; simulated Telegram
     failure results in text fallback.

9. Tests and typecheck.
   - Dependencies: tasks 1-8.
   - Add focused unit tests for config parsing/defaults, intent gating, path
     extraction/validation, collector lifecycle, sink mapping, and Telegram
     `sendDocument`.
   - Run `bun run typecheck` and `bun test`.
   - Run schema gate only if structured app-server metadata handling needs a
     generated schema update.

10. Documentation and manual checklist.
    - Dependencies: tasks 1-9.
    - Update README Telegram runtime section with outbound document delivery
      behavior, limits, and safety constraints.
    - Update M2 manual/review checklist with a bounded file-delivery smoke:
      create a small workspace file and ask Telegram to send it; verify the
      document arrives; ask for an outside-workspace file and verify fallback;
      ask for an oversized file and verify bounded fallback.
    - Document that Codex cannot directly send Telegram files; codexclaw host
      detects deliverable local files after an explicitly file-delivery-intended
      turn and sends them through the host adapter.
    - Update `.env.example` with the default-off file-delivery flags and bounded
      limit examples.
    - Validation: docs use Bun commands, do not imply Codex has Telegram
      credentials/tools, and preserve M2 inbound-upload/rich-media non-goals.

## Dependencies

- Existing Telegram adapter and `TelegramFetchApiClient`.
- Existing runtime event dispatch and `ChannelAdapterSink`.
- Existing runtime path config and workspace root resolution.
- Bun `fetch`, `FormData`, and file/blob support for multipart upload.
- Pinned Codex app-server behavior from M0 for assistant deltas and optional
  file-change metadata.

## Expected File Changes

- `src/channel/types.ts`: outbound local document attachment shape.
- `src/runtime/types.ts`: document delivery event/reference sketches and, if
  needed, non-persisted intent metadata.
- `src/runtime/events.ts`: per-turn candidate collection and terminal delivery
  trigger, or a delegated coordinator call.
- `src/runtime/host.ts`: sink mapping for document delivery attachments and
  current-turn intent wiring.
- `src/runtime/router.ts`: minimal handoff point for current-turn intent if the
  router owns turn start correlation.
- `src/channel/telegram.ts`: `sendDocument` API method and attachment handling.
- `src/config/env.ts`: file delivery config and redaction-safe limits.
- New small module under `src/runtime/file-delivery.ts` or
  `src/artifacts/file-delivery.ts`.
- Tests under `test/runtime/`, `test/channel/`, and `test/config/`.
- `.env.example`: document default-off file-delivery flags.
- `README.md`, `docs/M2-manual-checklist.md`, and
  `docs/M2-review-checklist.md`.

## Type And Interface Sketches

```ts
type FileDeliverySource = "assistant_path" | "runtime_file_metadata";
type FileDeliveryIntent = "none" | "send_file";

interface FileDeliveryConfig {
  enabled: boolean;
  allowedRoots: readonly string[];
  maxFileBytes: number;
  maxFilesPerTurn: number;
}

interface TurnFileCandidateState {
  threadId: ThreadId;
  turnId?: TurnId;
  channel: ChannelName;
  userKey: UserKey;
  channelThreadKey?: string;
  intent: FileDeliveryIntent;
  candidates: readonly CandidatePath[];
}

interface DocumentDeliveryOutcome {
  accepted: readonly LocalDocumentRef[];
  rejected: readonly RejectedDocumentRef[];
  fallbackText: string;
}
```

## Validation Criteria

- Unsafe file-delivery config is rejected; defaults align with the workspace
  boundary and Telegram file delivery remains off unless
  `CODEXCLAW_TELEGRAM_FILE_DELIVERY_ENABLED=true`.
- Attachment/event boundary remains channel-neutral and metadata-only.
- Intent-gating tests prove normal path mentions do not send documents.
- Scheduler-originated turns cannot emit `document_delivery`.
- Path validation tests cover allowed, denied, symlink, missing, directory,
  too-large, duplicate, escape cases, and path/object swaps before upload.
- Candidate state is in-memory only and clears on completion, failure,
  disconnect, and close paths.
- Runtime sink sends document delivery only after delta flush.
- Telegram `sendDocument` works in fake API tests and redacts token-bearing
  failures.
- User fallback and logs are bounded and content-safe.
- `bun run typecheck` and `bun test` pass.
- README and checklists accurately describe host-layer delivery and non-goals.

## Risks And Unknowns

- Unknown: exact Telegram multipart behavior in Bun for local file upload.
  Smallest spike: fake local HTTP server receives `sendDocument` multipart from
  `TelegramFetchApiClient` and asserts fields, filename, and redacted failures.
- Unknown: whether pinned app-server exposes reliable structured generated-file
  paths beyond raw diff/file-change events. Smallest spike: extend the existing
  `bun run spike:diff-tool` observation to record only method names and
  path-field keys, not raw diffs or content.
- Risk: assistant output path parsing can be prompt-injected. Mitigation: treat
  parsed paths as untrusted candidates; require current-turn delivery intent and
  host filesystem validation under allowed roots and bounded limits.
- Risk: accidentally sending secrets from workspace. Mitigation: deny known
  sensitive roots/segments, deny state/token/db/Codex rollout paths, enforce
  size/file-count limits, and document that users should not ask the bot to
  deliver secrets.
- Risk: memory growth during long turns. Mitigation: bounded candidate count and
  bounded extraction buffer per active turn.
- Risk: delivery duplicates when assistant repeats paths. Mitigation: dedupe by
  realpath and cap files per turn.
- Risk: this expands beyond the M2 non-goal. Mitigation: frame as a later
  bounded outbound-only file delivery plan; no inbound uploads, rich media, or
  general attachment UX.

## Review History

| Round | Reviewer | Date | Status | Notes |
| --- | --- | --- | --- | --- |
| 0 | planner | 2026-05-12 | draft | Initial read-only plan content for Telegram outbound file/document delivery. |
| 1 | implementation-reviewer | 2026-05-12 | fixes applied | Excluded scheduled turns, made Telegram file delivery default-off with explicit env flags, and added just-in-time upload validation to close path swap risks. |
