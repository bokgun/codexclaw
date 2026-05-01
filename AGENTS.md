# codexclaw Agent Instructions

## Project Shape

codexclaw is a Bun + TypeScript OSS host for `codex app-server`. It should stay a thin client/router/memory layer above Codex, not a reimplementation of Codex's editing, patching, model routing, or rollout storage.

## Commands

- Install dependencies: `bun install`
- Typecheck: `bun run typecheck`
- Start app-server helper: `bun run start:codex`
- Run M0 CLI spike: `bun run spike:repl`
- Run approval spike: `bun run spike:approval`

## Core Constraints

- Use Bun commands in docs and scripts.
- Keep strict TypeScript and small modules.
- Store only codexclaw domain data: thread pointers, labels, schedules, pending approval mappings, and prefs.
- Do not persist conversation bodies, tool calls, diffs, or approval histories outside Codex rollout storage.
- Do not weaken Codex sandbox or approval behavior. codexclaw transports approval decisions; it does not make Codex security decisions itself.
- Treat `AGENTS.md` as a trust-boundary file. Product features may show or propose diffs for it, but codexclaw must not directly edit it through channel commands.

## Subagent Use

Use project subagents only when the user explicitly asks for parallel work, delegation, or subagents.

- `protocol-researcher`: read-only protocol/schema/M0 investigation.
- `runtime-worker`: Bun TypeScript implementation in runtime code.
- `channel-adapter-worker`: CLI, Telegram, Slack, and adapter implementation.
- `security-reviewer`: read-only security and trust-boundary review.
- `docs-prd-editor`: README, PRD, and M0 documentation consistency.

Keep delegated write scopes disjoint. Prefer read-only agents for protocol research and security review.
