# codexclaw Roadmap

Last updated: 2026-05-12
Source of truth: `docs/seed/PRD.md` v1.1

This roadmap translates the PRD milestones into execution phases. It keeps the PRD's core constraint intact: codexclaw is a thin Bun + TypeScript host above `codex app-server`, not a reimplementation of Codex.

## Current Status

M0 through M4 implementation work is complete enough for the current roadmap
baseline, and MCP-backed plugin viability has been validated as the next major
product direction:

- Bun + TypeScript project initialized.
- Local `codex app-server` startup helper exists.
- JSON-RPC WebSocket client spike exists.
- CLI REPL spike exists.
- Approval demo spike exists.
- Active app-server schemas are checked in, pinned, and verified by
  `bun run schema:verify`.
- Project subagents and planning/review workflows are configured.
- CLI, Telegram, Discord personal mode, scheduler, pointer store, approval
  bridge, thread lifecycle, skills inspection, container docs, and install
  guidance have implementation coverage from the M1-M4 tracks.
- MCP direct calls and normal turn-mediated MCP tool use have been validated,
  including a minimal OpenCandle-backed MCP spike.

M0 findings now record observed behavior for initialize, thread, turn
streaming, approval, cancel, reconnect, and active schema provenance.

MCP plugin production work is now tracked as M5. The detailed execution roadmap
is `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`.

## Release Gates

| Gate | Required Before | Criteria |
| --- | --- | --- |
| M0 Gate | M1 Core | All PRD §16.4 success criteria pass, and no PRD §16.5 hard failure remains unresolved. |
| Schema Gate | M1 Core | Generated schemas match the pinned Codex CLI/app-server version. M1 cannot proceed from planning into implementation while app-server schemas come from an ambient, unpinned `codex` binary. |
| Security Gate | Channel releases | Channel credentials, user identity, approval routing, token handling, and AGENTS.md trust boundary are reviewed. |
| Plugin Security Gate | M5 Plugin milestones | Plugins are disabled by default, descriptors validate command/env/network metadata, raw MCP args/output are not persisted, and MCP elicitation remains fail-closed unless separately designed. |
| GA Gate | v1.0 | Install path, docs, container guidance, CLI, Telegram stable channel, Discord personal mode, Scheduler, Pointer Store, Approval Bridge, and thread lifecycle commands are usable by a fresh clone user. |

## M0 - App-Server Runtime Spike

Goal: prove that `codex app-server` can be treated as a reliable external agent runtime.

Status: complete.

Deliverables:

- Direct WebSocket initialization.
- Thread creation and resume.
- Turn start and streamed response handling.
- Diff/tool event observation.
- Approval approve/reject round trip.
- Cancel/timeout behavior notes.
- Reconnect behavior notes.
- Minimal pointer-store validation notes.
- `docs/M0-findings.md` updated with exact method names, event names, payload shapes, and decisions.

Exit criteria:

- `initialize` succeeds.
- `thread/start` succeeds.
- `turn/start` produces streamed output.
- Approval approve/reject round trip succeeds.
- Reconnect allows the same thread to continue without duplicate turn execution.
- Timeout/cancel is tested and the same thread can accept a safe subsequent turn.
- If cancel/timeout cannot be controlled externally, M0 fails and the product scope must be redesigned per PRD §16.5. Quarantine is a mitigation for non-deterministic edge cases, not a substitute for M0 success.

## M1 - Core Host Runtime

Goal: build the reusable host layer above the verified app-server protocol.

Implemented core slice:

- Router and inbox normalization.
- Pointer Store backed by SQLite.
- User-key and label based thread routing.
- Thread Manager slash commands:
  - `/new [label]`
  - `/threads`
  - `/switch <label>`
  - `/branch [label]` returns an explicit capability error until
    `thread/fork` is verified for the pinned app-server.
  - `/archive <label>` returns an explicit capability error until
    `thread/archive` is verified for the pinned app-server.
- Three-way Approval Bridge:
  - Approve
  - Reject
  - Modify as reject plus follow-up turn
- Reconnect handling that blocks routing while disconnected, quarantines
  ambiguous in-flight threads, and resumes known active threads with
  `thread/read` plus `thread/resume`.
- Turn concurrency guard for one active turn per thread.
- One-active-approval queueing, approval expiry auto-reject, and Modify as a
  rejected original approval plus follow-up turn.
- Structured stderr logging.
- Focused tests for router, pointer store, channel contracts, approval, and
  logging paths.

M1 validation includes focused mock tests plus a live local `bun run cli`
`/quit` smoke against `codex app-server`. Manual interactive validation is
tracked in `docs/M1-manual-checklist.md`. Adapter-specific interactive Modify
text-entry timeouts remain part of Telegram/Discord adapter work, where the
platform modal/reply flow exists.

Non-goals:

- Telegram or Discord production adapter behavior.
- Scheduler.
- Team/shared Discord or Slack thread semantics.
- Codex Cloud integration.

Exit criteria:

- CLI can route through the same core runtime used by future channels.
- Approval timeout, Modify timeout, and one-active-approval queueing are validated in the core runtime before Telegram or Discord adapters build on it.
- Conversation bodies, tool calls, diffs, and approval histories are not persisted by codexclaw.
- Pointer Store persists only PRD-approved domain data.
- `bun run typecheck` and focused tests pass.

## M2 - Telegram Channel

Goal: ship the first stable remote personal channel.

Planned scope:

- Telegram inbound adapter.
- Telegram outbound message formatting.
- Inline approval UX with Approve, Reject, Modify.
- Modify reply flow.
- New thread suggestion after 4 hours of inactivity.
- Daily throttle and 7-day suppress behavior for branch suggestions.
- Telegram secret/token handling guidance.
- Channel message to pending approval mapping.

Exit criteria:

- A single user can operate codexclaw through Telegram without CLI fallback.
- Approval timeout and Modify timeout behave as defined in the PRD.
- Telegram credentials never reach Codex app-server or spawned tool environments.

## M3 - Discord And Scheduler

Goal: add Discord personal mode and safe automation.

Planned scope:

- Discord personal-mode stable adapter keyed by `user_key`.
- Discord message component approval UX.
- Discord modal flow for Modify.
- Scheduler with required controls:
  - retry
  - timeout
  - dedupe with concurrency 1
  - 5 consecutive failures disable the task
- Task-bound named thread support.
- `prefs` key-value support for whitelisted user preferences:
  - `lang`
  - `tone`
  - `verbosity`

Non-goals:

- Shared team/community thread semantics. Shared threads belong to v1.x experimental, not v1.0 GA.
- Budget controls.
- Multi-tenant SaaS behavior.

Exit criteria:

- Discord operates in stable personal mode only. Messages in shared Discord channels still route by the sender's `user_key`.
- Discord approval buttons and Modify modal complete the approve, reject, modify, timeout, and one-active-approval flows defined by the core Approval Bridge.
- Discord interaction signatures are verified before any command, approval response, or modal submission is trusted.
- Retry uses bounded backoff and reports final failure.
- Task timeout attempts turn cancel and records the result.
- Scheduler cannot stack duplicate runs for the same task.
- Failed scheduled tasks are visible to the user and stop after the failure threshold.

## M3.5 - Knowledge Wiki

Goal: add an inspectable knowledge layer for fork-specific agent customization
after the stable personal channels and scheduler exist, before deployment
hardening freezes the operating model.

Planned scope:

- Markdown wiki workspace for agent-maintained project and user knowledge.
- Source-first ingest model:
  - raw sources remain untouched;
  - compiled wiki pages are generated or revised as separate Markdown artifacts;
  - source references are preserved where practical.
- Wiki conventions document for page structure, linking, ingest, query, and lint.
- User-steered commands or workflows to:
  - ingest selected files or notes;
  - summarize selected conversation knowledge into the wiki only when requested;
  - query the compiled wiki;
  - lint for stale claims, missing links, contradictions, and orphan pages.
- Clear storage boundary: the wiki may store human-reviewable knowledge, but
  must not persist conversation bodies, tool calls, diffs, approval histories,
  or hidden rollout replicas outside Codex.
- Fork customization examples showing how agent profiles and channel behavior
  can refer to the wiki without bypassing Codex sandbox or approval policy.

Non-goals:

- Vector database or opaque embedding-first memory.
- Automatic capture of every conversation.
- Reimplementation of Codex rollout storage, editing, patching, or approval
  enforcement.

Exit criteria:

- A fresh fork can add raw notes and compile them into linked Markdown wiki
  pages with a documented workflow.
- The user can inspect and edit all persistent wiki knowledge with normal file
  tools and git.
- Wiki operations respect the PRD storage boundary and do not save Codex-owned
  histories outside Codex rollout storage.
- M4 hardening docs can describe the wiki as an optional, auditable host-layer
  customization feature.

## M4 - Hardening And Deployment

Goal: make the project safe and easy to operate on a user-owned host.

Planned scope:

- WSS and reverse-proxy deployment guide.
- Container reference setup.
- Token file permission checks and guidance.
- Boot-time `thread/list` synchronization.
- Drift detection with lightweight `thread/read`.
- Status handling for active, archived, missing, and quarantined threads.
- Codex app-server skills discovery:
  - verify `skills/list` against the pinned app-server schema;
  - document returned fields and failure modes;
  - expose read-only skill listing with clear `codex` scope labels.
- Host skill registry design:
  - distinguish Codex agent skills from codexclaw host/channel skills;
  - define metadata for name, scope, description, and enabled state;
  - keep host skills from bypassing Codex sandbox or approval policy.
- Unified skills documentation explaining Codex skills, host skills, and their
  separate security boundaries.
- JSON-line logging conventions.
- Raspberry Pi 4 / 8GB smoke path.
- `codexclaw.sh` one-command install script.
- Interactive install prompts for `CODEXCLAW_WORKSPACE_ROOT`,
  `CODEXCLAW_STATE_DIR`, channel credentials, and safe defaults.
- README and operations docs for public OSS release.

Exit criteria:

- Fresh clone to first remote-channel response is documented and achievable in 15 minutes on a supported Mac/Linux host.
- Non-loopback deployments document TLS and token requirements.
- Thread drift and missing thread states produce clear user-facing recovery guidance.
- Users can inspect available Codex and host skills with source/scope labels,
  without granting new execution privileges.

## M5 - MCP-Backed Local Plugins

Goal: add local plugin capability through MCP while keeping Codex app-server in
charge of tool discovery and invocation.

Reference roadmap:

- `docs/plans/2026-05-12-mcp-plugin-production-roadmap.md`

Planned sequence:

- M5a descriptor schema and security gate.
- M5b local registry and config resolution.
- M5c process supervision.
- M5d channel UX.
- M5e OpenCandle production plugin slice.
- M5f hardening and release documentation.

Non-goals:

- plugin marketplace or remote plugin downloads;
- client-side dynamic tool execution bridge;
- bypassing Codex sandbox or approval behavior;
- persisting raw MCP arguments, raw MCP output, conversation bodies, diffs, or
  approval histories in codexclaw state.

Exit criteria:

- Plugins are disabled by default and require explicit enablement.
- Validated enabled plugin descriptors can be projected into app-server MCP
  config.
- codexclaw can supervise local MCP plugin server processes with bounded,
  redacted lifecycle status.
- Telegram, Discord, and CLI users can inspect plugin status and enable or
  disable plugins with network/provider warnings.
- OpenCandle is available as a first production-style local MCP plugin slice.
- `bun run typecheck`, focused tests, and plugin manual validation pass.

## v1.0 GA

Goal: publish a stable personal codexclaw release.

Required capabilities:

- CLI/REPL for debugging.
- Telegram stable channel.
- Discord stable personal mode.
- Scheduler.
- Pointer Store.
- Approval Bridge.
- Thread lifecycle commands.
- WSS/container deployment guidance.
- Local MCP plugin support with an explicitly enabled first-party sample or
  OpenCandle slice.
- MIT license and public OSS documentation.

Success indicators:

- Core host code remains near the PRD target of 2,000 LoC.
- Runtime dependencies stay intentionally small.
- External contributors can add a channel adapter without touching core routing internals.

## v1.x Experimental

Candidate scope after v1.0:

- Slack personal mode and shared team thread mode behind an explicit experimental flag.
- WhatsApp, Matrix, iMessage relay, or Email adapters as skills.
- Skill selection UX such as `/skill use <name>` after M4 validates discovery
  and boundaries.
- Plugin marketplace or remote plugin installation, if local MCP plugins prove
  stable enough to justify the larger security model.
- More complete stream recovery if app-server protocol support allows it.
- Schema-diff automation in CI.

## v2 Candidates

Out-of-scope for v1, but worth revisiting after real usage:

- Codex Cloud or other managed remote runtime integration.
- Topic-change based thread suggestion.
- Usage and budget controls based on observed operating data.
- Multi-tenant hosting model.
- GUI dashboard, if channel-only operations prove insufficient.
