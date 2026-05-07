# M4c Skills Inspection Plan

## Goal

Expose a read-only view of Codex agent skills and codexclaw host capabilities
without adding a skill execution engine, marketplace, plugin management, or any
writes to Codex skill configuration.

## PRD References

- PRD section 6.3: schema sync and generated app-server request/notification
  types.
- PRD section 8.1: codexclaw storage boundary and no replication of
  Codex-owned content.
- PRD section 9: no sandbox, approval, token, or trust-boundary weakening.
- PRD section 10: Bun/TypeScript runtime expectations.
- `docs/ROADMAP.md` M4: skills discovery, host skill registry, and unified
  skills docs.
- Parent M4 tasks 7, 8, and 9.

## Parent Plan

- `docs/plans/2026-05-07-m4-hardening-deployment.md`
- Covers parent tasks 7, 8, and 9.

## Scope

- Add read-only `skills/list` support through `CodexRuntimeClient`.
- Cache normalized Codex skills in process memory only; do not write skill
  metadata to SQLite or files.
- Treat `skills/changed` notification as cache invalidation only.
- Add a static host skill registry for codexclaw-owned capabilities: channel
  adapters, scheduler, wiki, runtime host metadata, and a static disabled
  installer placeholder. M4e owns the real installer surface.
- Add `/skills list` command output with family/source/scope labels.
- Update command parser and docs.
- Keep paths bounded, shortened, or redacted for channel output.
- Sanitize or omit sensitive generated fields such as dependency command
  bodies, dependency URLs, and interface default prompts.

## Non-goals

- No `/skill use <name>` command.
- No `skills/config/write`.
- No `marketplace/*` or `plugin/*` requests.
- No direct filesystem scanning of `SKILL.md`.
- No persistence of skill metadata.
- No rendering dependency command bodies, dependency URLs, default prompts, or
  secrets.
- No execution privilege changes.

## Ordered Tasks

1. Add client method and notification event.
   - Dependencies: generated `SkillsListParams`, `SkillsListResponse`, and
     `skills/changed` notification schema.
   - Validation: tests assert `cwds: [workspaceRoot]`, force reload params,
     event invalidation, and no `skills/config/write`.

2. Add Codex skill normalization and cache.
   - Dependencies: task 1 and M4a workspace path normalization.
   - Validation: tests cover returned skills, per-cwd errors, cache miss,
     cache hit, force reload, no DB writes, and no raw sensitive generated
     fields in summaries.

3. Add host skill registry.
   - Dependencies: existing channel, scheduler, and wiki config surfaces. Any
     installer entry is a static disabled placeholder until M4e implements the
     real installer workflow.
   - Validation: tests verify host skills are labeled `host`, disabled channel
     skills remain visible, entries contain no secrets or executable command
     bodies, and `boundary` is metadata-only.

4. Add unified listing service.
   - Dependencies: tasks 2 and 3.
   - Validation: tests cover merge/sort by family, scope, name; path shortening;
     output budget; bounded errors; and fail-closed behavior on `skills/list`
     errors.

5. Add command parser and router handling.
   - Dependencies: task 4 and existing command parser.
   - Validation: `/skills list` works through `Router`; unknown `/skills ...`
     and `/skill ...` fail closed; output is bounded for channel use.

6. Update docs.
   - Dependencies: tasks 1-5.
   - Validation: docs explain Codex `SKILL.md` behavior, host metadata,
     wiki relation, read-only M4 scope, and post-M4 skill selection UX.

## Dependencies

- Generated skills schema under `schemas/generated`.
- Existing runtime event path in `CodexRuntimeClient` and `HostRuntime`.
- Existing command parser and router command surface.
- Existing channel output constraints.
- M4a workspace/state path normalization for path rendering.
- Existing wiki configuration, which remains data/context only.
- No dependency on M4e installer implementation; installer visibility is a
  static placeholder in this slice.

## Files Expected To Change

- `src/codex/runtime-client.ts`
- `src/runtime/events.ts`
- `src/runtime/host.ts`
- `src/runtime/router.ts`
- `src/runtime/types.ts`
- `src/channel/commands.ts`
- `src/channel/types.ts`
- `src/skills/codex-skills.ts`
- `src/skills/host-registry.ts`
- `src/skills/index.ts`
- `test/skills/*.test.ts`
- `test/channel/commands.test.ts`
- `test/runtime/router.test.ts`
- `docs/skills.md`
- `docs/slash-commands.md`

## Type And Interface Sketches

```ts
type SkillFamily = "codex" | "host";

interface CodexSkillSummary {
  family: "codex";
  name: string;
  description: string;
  scope: "user" | "repo" | "system" | "admin";
  pathLabel: string;
  enabled: boolean;
  cwdLabel: string;
  errors: readonly string[];
}

interface CodexSkillListCache {
  workspaceRoot: string;
  forceReloadAvailable: boolean;
  invalidated: boolean;
  summaries: readonly CodexSkillSummary[];
}

interface HostSkillSummary {
  family: "host";
  name: string;
  scope: "host" | "channel" | "wiki" | "scheduler" | "installer";
  enabled: boolean;
  sourceLabel: string;
  boundary: "metadata_only";
}

interface UnifiedSkillSummary {
  family: SkillFamily;
  name: string;
  scope: string;
  enabled: boolean;
  sourceLabel: string;
  description: string;
  errors: readonly string[];
}

interface SkillOutputPolicy {
  maxItems: number;
  maxErrorChars: number;
  renderPath: "workspace_relative" | "home_relative" | "redacted";
}
```

## Pseudocode

```text
on /skills list:
  if codex skill cache is missing or invalidated:
    call skills/list with cwds containing normalized workspace root
    normalize returned skills and per-cwd errors
    omit dependency command/url and interface defaultPrompt
    store normalized summaries in process memory only
  collect host registry metadata
  merge host and Codex summaries
  sort by family, scope, name
  shorten paths and bound errors
  send bounded read-only output

on skills/changed notification:
  mark Codex skills cache invalidated
  do not fetch immediately
  do not call skills/config/write
  do not write database or files
```

## Validation

- `bun test test/skills test/channel/commands.test.ts test/runtime/router.test.ts`
- `bun run typecheck`
- `bun run schema:verify`
- Tests cover no DB writes, no raw absolute private paths in channel output, no
  dependency command/url/default prompt rendering, bounded per-cwd errors,
  `skills/changed` invalidation without config writes, `/skills list` through
  `Router`, unknown skill subcommands fail closed, and no
  `skills/config/write`.

## Risks And Unknowns

- Unknown: live `skills/list` output shape across user, repo, system, and admin
  scopes. Smallest spike: call `skills/list` for the workspace with and without
  `forceReload`, recording field names only.
- Unknown: per-cwd error shape. Smallest spike: request a cwd with known missing
  or invalid skill roots and record bounded error metadata.
- Unknown: whether `skills/changed` has empty params as generated. Smallest
  spike: observe notification and confirm invalidation-only handling.
- Unknown: deriving host enabled state without secrets. Smallest spike: inspect
  config surfaces and expose booleans only.
- Risk: path output can leak private directories. Mitigation: shorten relative
  to workspace/home/state and redact anything else.

## Review History

| Round | Reviewer | Date | Result | Notes |
| --- | --- | --- | --- | --- |
| 0 | main | 2026-05-07 | draft | Split from committed M4 parent plan. |
| 1 | planner | 2026-05-07 | fixes applied | Added PRD traceability, storage/security boundaries, required sections, schema-sensitive sanitization, and stronger validation. |
| 2 | implementation-reviewer | 2026-05-07 | fixes applied | Removed M4e installer dependency by making installer host skill visibility a static disabled placeholder. |
| 3 | implementation-reviewer | 2026-05-07 | no findings | Re-reviewed all five M4 subplans after fixes. |
