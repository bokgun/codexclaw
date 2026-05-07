# M4e Installer And Release Checklist Plan

## Goal

Finish M4 with a real, inspectable `codexclaw.sh` installer, README
integration, `.env.example` final alignment, and a release checklist that proves
a fresh clone can reach a first CLI or remote-channel response with safe
defaults.

## PRD References

- PRD section 5.3: deployment isolation guidance.
- PRD sections 6.1 and 6.4: WebSocket transport, bearer token file, `/readyz`,
  and reverse proxy requirements.
- PRD sections 8.1, 8.2, and 8.5: pointer storage boundary, label/thread
  behavior, and recovery expectations.
- PRD section 9: no sandbox, approval, token, or trust-boundary weakening.
- PRD section 10: Bun/TypeScript runtime, Raspberry Pi support, and JSON-line
  logging.
- PRD section 11: minimal `.env` configuration.
- PRD sections 12 and 13: M4/v1.0 GA hardening and release readiness.
- `docs/M0-findings.md`: pinned commands and schema gate.
- `README.md`: current env and runtime command behavior.

## Parent Plan

- `docs/plans/2026-05-07-m4-hardening-deployment.md`
- Covers parent tasks 13 and 14, plus final integration validation for M4a-M4d.

## Scope

- Add a real `codexclaw.sh` with `--dry-run` and interactive mode. It should be
  intentionally small, inspectable, and safe, not a broad package manager.
- Prompt for workspace, state dir, app-server URL, token file, channel choice,
  channel credentials, scheduler, wiki, and deployment mode.
- Require Telegram and Discord allowlists unless the user explicitly selects
  local-only developer mode and explicitly enables the matching allow-all flag.
- Show a no-secrets summary before writing.
- Refuse unsafe remote-channel defaults.
- Avoid overwriting existing secrets without confirmation.
- Update README for fresh-clone setup and links to M4a-M4d outputs.
- Final-align `.env.example` after M4a, M4c, and M4d land.
- Add `docs/M4-manual-checklist.md`.
- Reconcile and link M4a-M4d docs; do not re-own their content.
- Run final M4 validation across typecheck, tests, schema gate, and documented
  smokes where credentials are available.

## Non-goals

- No unattended production bootstrap with secret managers.
- No GUI dashboard.
- No package manager install outside documented Bun commands.
- No direct editing of `AGENTS.md`.
- No enabling Telegram or Discord allow-all-users unless explicitly local-only.
- No reimplementation of M4c skills docs or M4d deployment docs.

## Ordered Tasks

1. Audit M4a-M4d outputs.
   - Dependencies: none.
   - Validation: audit records whether M4a deployment preflight, M4c
     `/skills list`, and M4d docs are complete. Installer implementation may
     start from the audit, but README/checklist/final release validation must
     wait for completed M4a-M4d outputs rather than stubs.

2. Define installer contract.
   - Dependencies: task 1 and `package.json` Bun scripts.
   - Validation: `codexclaw.sh --dry-run` prints planned `.env` changes without
     secrets; interactive mode confirms before writing.

3. Define prompt/env model.
   - Dependencies: M4a final env names and `.env.example`.
   - Validation: dry-run cases cover default local setup, custom workspace,
     custom state dir, local-dev workspace-internal opt-in, Telegram-only,
     Discord-only, no channel, scheduler, wiki, empty allowlist rejection, and
     allow-all flag rejection outside explicit local-only developer mode.

4. Implement safe `.env` merge/write flow.
   - Dependencies: tasks 2-3 and runtime validation semantics.
   - Validation: tests or shell dry-run fixtures cover private file creation,
     preserving unrelated keys, refusing non-loopback `ws://`, rejecting unsafe
     workspace-internal state outside local-dev opt-in, and refusing secret
     overwrite without confirmation. Add a temp-directory interactive
     confirmation test that proves `.env` is written with private permissions,
     unrelated keys are preserved, and secret overwrite confirmation is
     enforced.

5. Add focused installer tests.
   - Dependencies: task 4.
   - Validation: tests run under Bun or shell without network and without
     writing outside temp directories.

6. Update README.
   - Dependencies: tasks 1-5 and completed M4a, M4c, and M4d outputs.
   - Validation: fresh-clone path uses Bun commands, explains workspace/state
     separation, keeps `/project` reserved, links deploy/logging/skills docs,
     and includes `/thread list`, `/skills list`, and `/quit`.

7. Add M4 manual checklist.
   - Dependencies: tasks 1-6 and completed M4a, M4c, and M4d outputs.
   - Validation: checklist covers `bun install`, installer dry run,
     `bun run schema:verify`, `bun run typecheck`, `bun test`,
     `bun run start:codex`, `bun run cli`, `/thread list`, `/skills list`,
     `/quit`, and one Telegram or Discord first-response smoke when credentials
     exist.

8. Run final release validation.
   - Dependencies: tasks 1-7 and completed M4a, M4c, and M4d outputs.
   - Validation: `bun test`, `bun run typecheck`, `bun run schema:verify`, and
     documented smoke outcomes are recorded in the final implementation notes.

## Dependencies

- M4a deployment-mode, path, token, logging, and app-server helper behavior.
- M4c `/skills list` command and skills docs.
- M4d local/WSS/container/Pi/logging docs.
- `src/config/env.ts` final env validation names.
- `.env.example` final env surface.
- `scripts/start-codex-app-server.sh`.
- `package.json` Bun scripts.
- Existing CLI, Telegram, and Discord runtime commands.

## Files Expected To Change

- `codexclaw.sh`
- `.env.example`
- `README.md`
- `docs/M4-manual-checklist.md`
- `test/installer/*.test.ts` or shell dry-run fixtures
- `test/config/env.test.ts` only if installer shares config validation fixtures
- Links to existing `docs/deploy/*.md`, `docs/logging.md`, and `docs/skills.md`
  after M4c/M4d provide them.

## Type And Interface Sketches

```ts
type InstallerMode = "dry_run" | "interactive";
type InstallChannelChoice = "cli" | "telegram" | "discord" | "none";

interface InstallerPromptAnswers {
  workspaceRoot: string;
  stateDir: string;
  deploymentMode: "local_dev" | "local_loopback" | "reverse_proxy_wss";
  codexWsUrl: string;
  tokenFile: string;
  channel: InstallChannelChoice;
  allowedUserIds: readonly string[];
  allowAllUsersForLocalDev: boolean;
  schedulerEnabled: boolean;
  wikiEnabled: boolean;
}

interface SecretValue {
  envKey: string;
  display: "[redacted]";
  overwrite: "preserve" | "confirm" | "replace";
}

interface EnvWritePlan {
  path: string;
  createMode: "0600";
  set: readonly string[];
  preserve: readonly string[];
  secrets: readonly SecretValue[];
}

interface InstallerSummary {
  mode: InstallerMode;
  envPath: string;
  workspaceRoot: string;
  stateDir: string;
  nextCommands: readonly string[];
}
```

## Pseudocode

```text
dry run:
  read current .env if present
  collect defaults from cwd, home, and M4a env names
  build env write plan
  validate ws url and workspace/state containment
  print no-secrets summary and next Bun commands
  write nothing

interactive install:
  prompt workspace root
  prompt deployment mode
  choose state dir default from deployment mode
  prompt app-server url and token file
  reject non-loopback ws:// and unsafe workspace-internal state
  prompt channel and only required credentials
  require allowlisted user ids for Telegram or Discord unless local_dev and
    explicit allow-all local-dev flag are both selected
  prompt scheduler/wiki defaults
  show redacted summary
  if confirmed:
    merge .env while preserving unrelated keys
    confirm before replacing existing secrets
    write with private permissions
    print next Bun commands
```

## Validation

- `bun test`
- `bun run typecheck`
- `bun run schema:verify`
- Installer dry-run tests cover:
  - default local setup
  - custom workspace
  - custom state dir
  - state outside workspace
  - local-dev workspace-internal opt-in
  - Telegram-only
  - Discord-only
  - empty Telegram/Discord allowlist rejection
  - allow-all user flag rejection outside explicit local-dev mode
  - no channel selected
  - non-loopback WSS requirement
  - refusal to overwrite existing secrets without confirmation
  - temp-directory interactive confirmation writes .env with private
    permissions and preserves unrelated keys
- Manual checklist covers fresh clone, first CLI response, `/thread list`,
  `/skills list`, `/quit`, and at least one remote-channel first response when
  credentials are available.

## Risks And Unknowns

- Unknown: shell test strategy. Smallest spike: dry-run-only tests in temp dirs
  that never touch the real workspace or network.
- Unknown: cross-platform chmod/stat behavior. Smallest spike: compare
  installer temp-file permissions with M4a runtime tests on supported hosts.
- Unknown: whether installer can share runtime validation without duplicating
  TypeScript logic. Smallest spike: evaluate a small Bun validation helper or
  keep shell validation minimal and covered by runtime tests.
- Unknown: M4a env names may change during implementation. Smallest spike:
  audit `.env.example`, README, installer, and `src/config/env.ts` together
  before M4e review.
- Risk: README can get ahead of implementation. Mitigation: M4e starts with an
  audit and only links commands/docs that exist.

## Review History

| Round | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 0 | main | 2026-05-07 | draft | Split from committed M4 parent plan. |
| 1 | planner | 2026-05-07 | fixes applied | Added PRD references, real installer requirement, scoped M4a-M4d reconciliation, required sections, and stronger validation. |
| 2 | implementation-reviewer | 2026-05-07 | fixes applied | Added remote-channel allowlist validation, tightened M4a-M4d completion dependencies, and added interactive write validation. |
| 3 | implementation-reviewer | 2026-05-07 | no findings | Re-reviewed all five M4 subplans after fixes. |
