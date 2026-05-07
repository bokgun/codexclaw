# M4d Ops Docs, Container, And Pi Plan

## Goal

Document practical deployment and operations paths so a fresh clone user can run
codexclaw safely on a local host, behind WSS, in a reference container layout,
or on Raspberry Pi 4 / 8GB without guessing where state, token, and workspace
files belong.

## PRD References

- PRD section 5.3: recommended container isolation model.
- PRD sections 6.1-6.4: WebSocket/WSS transport, `/readyz`, bearer token file,
  and reverse proxy requirement for public exposure.
- PRD section 9: token permissions, WSS, and no sandbox or approval weakening.
- PRD section 10: JSON-line stderr logs and Raspberry Pi support.
- PRD section 11: minimal `.env` configuration.
- `docs/M0-findings.md`: pinned app-server and schema verification constraints.
- `docs/ROADMAP.md` M4 deployment, logging, container, and Pi bullets.

## Parent Plan

- `docs/plans/2026-05-07-m4-hardening-deployment.md`
- Covers the local/WSS/container/Pi/logging subset of parent task 1, plus parent
  tasks 10, 11, and 12. Skills docs remain owned by M4c, and installer docs
  remain owned by M4e.

## Scope

- Add `docs/deploy/local.md` for local loopback operations.
- Add `docs/deploy/wss-reverse-proxy.md`.
- Add `docs/deploy/container.md`.
- Add `docs/deploy/raspberry-pi-smoke.md`.
- Add `docs/logging.md`.
- Update `.env.example` with deployment-mode comments introduced by M4a.
- Document JSON-line stderr logs, stable fields, log levels, redaction, and
  content summarization.
- Document mount boundaries: workspace, state, bearer token file, and SQLite
  database.
- Include `/readyz` and bearer token behavior.
- Keep all repo commands Bun-based.

## Non-goals

- No production SaaS deployment.
- No Kubernetes chart.
- No fully supported multi-project model.
- No container image publishing automation.
- No Raspberry Pi performance promises beyond a smoke path and known limits.

## Ordered Tasks

1. Create local operations doc.
   - Dependencies: M4a env names and app-server helper defaults.
   - Validation: doc uses Bun commands, explains loopback `ws://`, state outside
     workspace by default, `/readyz`, CLI `/quit`, and no remote exposure.

2. Write WSS/reverse proxy doc.
   - Dependencies: task 1 and M4a WebSocket validation decisions.
   - Validation: doc has no plaintext non-loopback exception, includes bearer
     token behavior, includes `/readyz`, and shows proxy-to-loopback/internal
     app-server flow.

3. Write container reference doc.
   - Dependencies: tasks 1-2 and M4a path/token rules.
   - Validation: workspace mount is separate from state/token/db mount, app
     server is loopback/internal, reverse proxy terminates WSS, and docs do not
     imply codexclaw replaces Codex sandboxing. The doc must include non-root
     guidance where feasible, read-only/allowlisted mount guidance, and symlink
     escape cautions for workspace and state mounts.

4. Write Raspberry Pi smoke doc.
   - Dependencies: tasks 1-3 and schema verification expectations.
   - Validation: doc covers ARM64/Linux assumptions, Bun install, `bun install`,
     `bun run typecheck`, `bun run schema:verify`, `bun run start:codex`, CLI
     `/quit`, optional Telegram/Discord smoke, slow steps, and resource
     expectations.

5. Write logging doc.
   - Dependencies: M4a logging env decisions.
   - Validation: doc states one JSON object per stderr line, stable fields,
     secret redaction, content summarization, and no raw prompts/diffs/tool
     output/conversation bodies. The doc must match final `src/runtime/log.ts`,
     `CODEXCLAW_LOG_LEVEL`, redaction behavior, and JSON-only runtime format.

6. Align `.env.example`.
   - Dependencies: tasks 1-5 and M4a final env names/defaults.
   - Validation: remote allow-all flags disabled, state outside workspace by
     default, and local-dev workspace-internal state clearly labeled.

## Dependencies

- M4a config/preflight outputs and final env names.
- Pinned Codex app-server schema gate.
- Existing `scripts/start-codex-app-server.sh`.
- README env semantics and Bun 1.1+ requirement.
- App-server `/readyz` and bearer token behavior.
- Existing Telegram/Discord/scheduler/wiki docs from M2-M3.5.

## Files Expected To Change

- `.env.example`
- `docs/deploy/local.md`
- `docs/deploy/wss-reverse-proxy.md`
- `docs/deploy/container.md`
- `docs/deploy/raspberry-pi-smoke.md`
- `docs/logging.md`

## Type And Interface Sketches

```ts
type DeploymentMode = "local_dev" | "local_loopback" | "reverse_proxy_wss";
type MountRole = "workspace" | "state" | "token" | "db";

interface DeploymentDocAssertion {
  topic: "wss" | "container" | "pi" | "logging" | "local";
  mustState: readonly string[];
  mustNotState: readonly string[];
}

interface LogFieldContract {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  metadata: "bounded_redacted_json";
}

interface PiSmokeStep {
  command: string;
  expected: string;
  optionalCredentials: boolean;
}
```

## Pseudocode

```text
choose deployment docs path:
  if local only:
    use local loopback doc and outside-workspace state
  if remote channel or public exposure:
    use reverse proxy WSS doc
  if containerized:
    mount workspace separately from state/token/db

reverse proxy flow:
  client connects over wss
  reverse proxy validates TLS path
  proxy forwards to loopback/internal app-server
  app-server enforces bearer token

Pi smoke:
  install Bun
  run bun install
  run typecheck and schema verify
  start app-server
  run CLI /quit smoke
  run one remote channel smoke only if credentials exist
```

## Validation

- Manual docs review verifies:
  - Bun commands only for repo operations
  - `CODEXCLAW_WORKSPACE_ROOT` and `CODEXCLAW_STATE_DIR` explained
  - state/token/SQLite stay outside the Codex-editable workspace by default
  - WSS plus bearer token required for non-loopback access
  - container doc separates workspace mount from state/token/db mount
  - container doc includes non-root, read-only or allowlisted mount, and symlink
    escape guidance
  - Pi smoke can be followed without code changes
  - logging docs prohibit raw prompt/diff/tool output in logs
  - logging docs match final runtime logger fields, env names, redaction
    behavior, and JSON-only format

## Risks And Unknowns

- Unknown: Raspberry Pi ARM64 availability and performance. Smallest spike: run
  install, `bun install`, `bun run typecheck`, `bun run schema:verify`,
  `/readyz`, CLI `/quit`, and record timings.
- Unknown: container networking ambiguity. Smallest spike: smoke app-server
  internally and verify only proxy-facing WSS is exposed.
- Unknown: docs drift from M4a env names. Smallest spike: compare `.env.example`
  and docs against final `src/config/env.ts` before implementation.
- Risk: docs can normalize unsafe local-dev defaults. Mitigation: examples keep
  state outside workspace except clearly labeled local-only mode.

## Review History

| Round | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 0 | main | 2026-05-07 | draft | Split from committed M4 parent plan. |
| 1 | planner | 2026-05-07 | fixes applied | Added PRD references, local ops doc scope, dependencies, type sketches, pseudocode, and task-level validation. |
| 2 | implementation-reviewer | 2026-05-07 | fixes applied | Narrowed parent-task mapping and added container security plus logging-runtime validation. |
| 3 | implementation-reviewer | 2026-05-07 | no findings | Re-reviewed all five M4 subplans after fixes. |
