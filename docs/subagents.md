# Subagents

codexclaw uses project-scoped Codex custom agents in `.codex/agents/`. They are intentionally narrow so parallel work stays easy to review.

## Configuration

Global limits for this repo live in `.codex/config.toml`:

- `features.multi_agent = true`
- `agents.max_threads = 4`
- `agents.max_depth = 1`
- `agents.job_max_runtime_seconds = 1800`

The custom agents omit `model`, so they inherit the parent session's selected model. Role files set only reasoning effort, sandbox mode where useful, and developer instructions.

## Roles

| Agent | Mode | Use For |
| --- | --- | --- |
| `planner` | read-only | PRD breakdown, milestones, task order, dependencies, and validation criteria |
| `protocol-researcher` | read-only | Codex app-server schema, JSON-RPC method/event names, M0 findings |
| `runtime-implementer` | write-capable | Bun TypeScript runtime implementation under `src/`, scripts, and package config |
| `adapter-implementer` | write-capable | CLI, Telegram, Discord, approval UX, and adapter boundaries |
| `implementation-reviewer` | read-only | Implementation correctness, PRD fit, test coverage, and maintainability |
| `security-reviewer` | read-only | Sandbox, approval, token, prompt-injection, and trust-boundary review |
| `docs-prd-editor` | write-capable | README, PRD, M0 findings, and documentation consistency |

## Operating Pattern

Use subagents only when the work is meaningfully parallel:

- A planner pass before starting a broad milestone or ambiguous PRD slice.
- One read-only protocol research pass while a runtime implementer handles known code.
- An implementation review after a bounded code change is ready.
- A security review after a bounded implementation is ready.
- A docs pass after code changes settle.

Avoid multiple write-capable agents touching the same files in parallel.

For plan-first and implementation review loops, follow `docs/workflows.md`.
