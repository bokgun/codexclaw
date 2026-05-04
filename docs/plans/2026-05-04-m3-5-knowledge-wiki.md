# M3.5 Knowledge Wiki Plan

## Goal

Add an optional, auditable Markdown knowledge wiki for fork-specific agent
customization while preserving codexclaw's thin-host boundary above Codex.
M3.5 must not depend on M3 Discord; it should work through the existing Bun and
TypeScript runtime and CLI-first workflows even if Discord remains postponed.

The wiki is a host-layer customization surface: humans can inspect, edit,
version, and review it with normal file tools. It must not become hidden memory,
a Codex rollout replica, or a replacement for Codex's editing, patching,
sandbox, approval, or conversation storage.

## PRD References

- `README.md` Vision: codexclaw is a thin, forkable shell around Codex for
  adapters, routing behavior, lightweight memory, and local workflows.
- `README.md` Vision note: the post-M3, pre-M4 Knowledge Wiki uses auditable raw
  sources and linked Markdown pages humans can inspect, edit, version, and
  review.
- `docs/ROADMAP.md` M3.5: Markdown wiki workspace, source-first ingest,
  conventions, user-steered commands/workflows, query, lint, and fork
  customization examples.
- `docs/ROADMAP.md` M3.5 non-goals: no vector database, no automatic capture of
  every conversation, and no reimplementation of Codex rollout storage, editing,
  patching, or approval enforcement.
- PRD §8.1: Codex rollout JSONL and sqlite metadata are the SSoT for thread
  content; codexclaw DB stores only codexclaw-domain mappings.
- PRD §8.5: prefs are data-only and cannot alter sandbox, approval, tool
  authority, or AGENTS.md trust boundaries.
- PRD §9: codexclaw transports decisions and routes messages; it does not
  weaken Codex sandbox or approval policy.
- `AGENTS.md`: do not persist conversation bodies, tool calls, diffs, or
  approval histories outside Codex rollout storage; `AGENTS.md` is a
  trust-boundary file.

## Scope

- Add a wiki workspace rooted in auditable Markdown files, separate from raw
  sources.
- Require every wiki artifact to be classified as either `project_public` or
  owned by one `user_key`. Query, context attachment, and lint output must
  enforce that classification.
  - `project_public` artifacts have no owner and are visible to all local users.
  - `user_private` artifacts must carry `ownerUserKey` and are visible only to
    that user.
- Define a source-first ingest model:
  - raw sources remain untouched;
  - compiled wiki pages are separate Markdown artifacts;
  - source references are preserved where practical;
  - generated artifacts are reviewable through normal file tools and git.
- Add a wiki conventions document covering page structure, links, source
  references, ingest, query, lint, stale-claim handling, and trust boundaries.
- Add CLI-first `/wiki` command support or equivalent channel command plumbing
  for:
  - ingesting explicitly selected local files or note files;
  - adding explicit user-provided notes;
  - summarizing selected conversation knowledge only when the user explicitly
    provides or requests the selection;
  - querying compiled wiki pages;
  - linting wiki pages for missing source refs, orphan pages, broken links,
    stale markers, and contradiction candidates.
- Add a small wiki runtime/service layer that is file-backed and Markdown-first.
- Add optional wiki context attachment to user turns only when requested or
  configured through a user-steered command.
- Add fork customization examples showing agent/channel profiles referencing
  wiki pages without bypassing sandbox, approval, or AGENTS.md policy.
- Add tests for path safety, source boundaries, command parsing, ingest
  manifests, query behavior, owner/public filtering, context sanitization, and
  lint reports.

## Non-goals

- No M3 Discord dependency; Discord commands can be added later using the same
  command model.
- No vector database, opaque embedding-first memory, or hidden semantic cache.
- No automatic capture of every conversation.
- No polling Codex rollout files for memory.
- No persistence of conversation bodies, tool calls, diffs, approval histories,
  compaction summaries, hidden rollout replicas, or raw Codex event payloads
  outside Codex.
- No direct edits to `AGENTS.md` through channel commands.
- No replacement for Codex editing, patching, model routing, rollout storage,
  sandboxing, or approval enforcement.
- No broad personal knowledge base, team wiki, SaaS sync, web dashboard, or
  multi-user authorization model beyond existing `user_key` ownership.

## Ordered Tasks

1. Define wiki storage layout and conventions
   - Dependencies: none.
   - Expected outcome: documented file layout and reviewable conventions.
   - Validation: a fresh clone can identify where raw sources, compiled pages,
     manifests, and lint reports live; docs state forbidden stored content
     explicitly.

2. Add wiki config boundary
   - Dependencies: task 1.
   - Expected outcome: config for wiki enablement, root path, allowed source
     roots, max file size, and default query limits.
   - Validation: invalid paths fail closed; defaults keep wiki optional.

3. Add ownership, path safety, and source reference model
   - Dependencies: task 1.
   - Expected outcome: every artifact is explicitly `project_public` or
     user-owned, and normalized source references cannot escape allowed roots or
     treat Codex rollout/session storage as an ingest source.
   - Validation: tests cover ownership filtering, traversal, symlink-sensitive
     assumptions, absolute/relative paths, missing files, and hard-denied
     Codex-owned storage paths.

4. Add Markdown artifact model and manifest design
   - Dependencies: tasks 1-3.
   - Expected outcome: wiki pages and ingest manifests carry enough metadata for
     audit without storing raw source copies.
   - Validation: ingest records source paths, optional ranges, hashes or mtimes
     where practical, generated page path, user key, timestamp, and operation
     type; no raw conversation/tool/diff payload fields exist.

5. Add source-first file ingest workflow
   - Dependencies: tasks 2-4.
   - Expected outcome: selected files or note files can produce proposed or
     compiled Markdown wiki artifacts.
   - Validation: raw source files remain untouched; generated pages include
     source references; binary, oversized, and disallowed files are rejected
     with bounded messages.

6. Add user-provided note workflow
   - Dependencies: tasks 2-4.
   - Expected outcome: a user can explicitly add a note as a wiki source or
     directly as a reviewable compiled artifact.
   - Validation: stored notes are clearly marked as user-provided; the command
     does not imply automatic conversation capture.

7. Add selected conversation knowledge workflow
   - Dependencies: tasks 1-4.
   - Expected outcome: a user can request summarization of selected conversation
     knowledge without codexclaw copying rollout history.
   - Validation: workflow requires explicit user steering, stores only the
     resulting human-reviewable Markdown artifact, and never stores raw
     conversation bodies, tool calls, diffs, approval histories, or Codex event
     payloads.

8. Add wiki query workflow
   - Dependencies: tasks 4-6.
   - Expected outcome: query searches compiled Markdown pages and returns
     bounded excerpts, page paths, and source refs.
   - Validation: query does not read Codex rollout storage; results cite wiki
     pages and sources; no hidden index is required for correctness.

9. Add wiki lint workflow
   - Dependencies: tasks 4-8.
   - Expected outcome: lint identifies broken links, orphan pages, missing
     source refs, stale source refs, disallowed-content markers, and
     contradiction candidates.
   - Validation: focused tests cover each lint category; contradiction
     detection is conservative and reported as candidate findings, not automatic
     truth. Lint reports persist only finding kinds, page paths, locations,
     hashes, and redacted/bounded snippets; they must not copy forbidden matched
     content into a second artifact.

10. Add Router and command integration
    - Dependencies: tasks 2, 5-9.
    - Expected outcome: `/wiki` command family routes to wiki workflows in
      CLI/runtime paths; Telegram can reuse normalized command parsing later;
      Discord is not required.
    - Validation: existing thread, task, approval, and prefs commands remain
      unchanged; unknown or malformed wiki commands fail with bounded usage
      text.

11. Add optional wiki context attachment
    - Dependencies: tasks 8 and 10.
    - Expected outcome: selected wiki query results can be attached to a turn as
      data-only context.
    - Validation: attached wiki context is labeled as data, cannot alter
      sandbox or approval authority, is size-limited, enforces
      `project_public`/owner visibility, escapes command-like and
      system/developer/tool-like prefixes, and is covered by malicious wiki
      fixture tests.

12. Add docs and examples
    - Dependencies: tasks 1-11.
    - Expected outcome: README or docs describe the wiki as optional auditable
      host-layer customization; examples show profile/channel references to
      wiki pages.
    - Validation: docs use Bun commands; examples do not require Discord; docs
      repeat storage boundary and AGENTS.md trust-boundary constraints.

13. Add validation checklist and tests
    - Dependencies: tasks 1-12.
    - Expected outcome: Bun tests and manual checklist cover wiki storage
      boundaries and CLI-first workflows.
    - Validation: `bun run typecheck`, `bun test`, and a manual wiki checklist
      pass.

## Dependencies

- Existing Bun + TypeScript runtime.
- Existing `src/channel/commands.ts` slash-command parser.
- Existing `src/runtime/router.ts` command handling.
- Existing `src/store/pointer-store.ts` only if minimal wiki metadata needs
  SQLite ownership pointers; prefer Markdown manifests first.
- Existing `src/codex/input.ts` data-only context pattern for prefs.
- Existing docs workflow and roadmap.
- No dependency on M3 Discord, Discord interactions, Discord scheduler work, or
  cross-channel task dispatch.

## Files / Modules Expected To Change

- `docs/wiki.md` or `docs/wiki-conventions.md`
- `docs/M3-5-manual-checklist.md`
- `README.md`
- `docs/ROADMAP.md` only if status/checklist links need updating
- `src/wiki/types.ts`
- `src/wiki/config.ts`
- `src/wiki/paths.ts`
- `src/wiki/manifest.ts`
- `src/wiki/ingest.ts`
- `src/wiki/query.ts`
- `src/wiki/lint.ts`
- `src/wiki/context.ts`
- `src/channel/types.ts`
- `src/channel/commands.ts`
- `src/runtime/router.ts`
- `src/codex/input.ts` or a sibling context composer module
- `src/config/env.ts`
- `test/wiki/*.test.ts`
- `test/channel/commands.test.ts`
- `test/runtime/router.test.ts`

Expected generated/runtime user artifacts:

- `wiki/README.md`
- `wiki/pages/*.md`
- `wiki/sources/*.md` only for explicit user-created notes, not copied raw
  repository files
- `wiki/manifests/*.json` or `.md`
- `wiki/lint/*.md` optional report output

## Type / Interface Sketches

```ts
type WikiArtifactKind =
  | "compiled_page"
  | "user_note"
  | "ingest_manifest"
  | "lint_report";

type WikiSourceKind =
  | "repo_file"
  | "user_note"
  | "selected_conversation_summary";

interface WikiConfig {
  enabled: boolean;
  wikiRoot: string;
  allowedSourceRoots: readonly string[];
  maxSourceBytes: number;
  maxQueryResults: number;
}

interface WikiSourceRef {
  kind: WikiSourceKind;
  displayPath: string;
  resolvedPath?: string;
  lineStart?: number;
  lineEnd?: number;
  contentHash?: string;
  observedAt: string;
}

interface WikiPageMeta {
  title: string;
  slug: string;
  visibility: "project_public" | "user_private";
  // Required when visibility is "user_private"; omitted for "project_public".
  ownerUserKey?: string;
  sourceRefs: readonly WikiSourceRef[];
  tags: readonly string[];
  generatedAt: string;
  updatedAt: string;
}

interface WikiIngestRequest {
  userKey: string;
  sourceRefs: readonly WikiSourceRef[];
  targetSlug?: string;
  requestedFocus?: string;
  mode: "propose" | "write_compiled_page";
}

interface WikiQueryRequest {
  userKey: string;
  queryText: string;
  limit: number;
  includeSourceRefs: boolean;
}

interface WikiQueryResult {
  pagePath: string;
  title: string;
  excerpt: string;
  sourceRefs: readonly WikiSourceRef[];
  scoreReason: string;
}

interface WikiLintFinding {
  severity: "error" | "warning" | "info";
  kind:
    | "broken_link"
    | "orphan_page"
    | "missing_source_ref"
    | "stale_source_ref"
    | "disallowed_content_candidate"
    | "contradiction_candidate";
  pagePath: string;
  message: string;
  sourceRefs: readonly WikiSourceRef[];
  redactedSnippet?: string;
  contentHash?: string;
}
```

Boundary ports:

- `WikiRepository`: read and write wiki pages, manifests, and reports within the
  configured wiki root.
- `WikiIngestPlanner`: inspect selected source references for the current
  operation and produce a proposed page draft.
- `WikiSearcher`: search compiled Markdown pages and return bounded query
  results.
- `WikiLinter`: inspect compiled pages, manifests, and source references and
  return lint findings.

## Pseudocode

### Source-First File Ingest

```text
on /wiki ingest <paths> [--slug <slug>] [--focus <text>] [--public|--private]:
  require wiki enabled
  normalize each selected path against allowed source roots
  hard-reject Codex rollout/session storage paths
  reject binary, oversized, missing, or unsafe paths
  read selected source text for the current operation only
  use deterministic local parsing for metadata only, or route model-authored summarization through Codex
  write compiled Markdown under wiki/pages
  write manifest with source refs, hashes/mtimes, visibility, owner user key, timestamp, and target page
  do not copy raw source file contents into hidden storage
  report page path and manifest path to user
```

### Explicit Note Ingest

```text
on /wiki note <title> <body-or-note-file>:
  require explicit user command
  store user note as auditable Markdown source or compile into page
  mark source kind as user_note
  preserve visibility, author user_key, and timestamp
  never infer that adjacent conversation messages should be captured
```

### Selected Conversation Knowledge

```text
on /wiki capture-selected <user-provided-selection-or-summary-request>:
  require explicit user request
  do not scan Codex rollout files
  do not call thread/read with turns or includeTurns-style options
  do not scrape stream buffers or channel logs for prior raw turns
  do not store raw conversation turns
  accept user-pasted selected text, or route a normal user turn through Codex to produce a summary
  accept only a bounded summary/proposed Markdown artifact as wiki output
  mark source kind as selected_conversation_summary
  include note that raw conversation remains in Codex rollout storage
```

### Query And Context Attachment

```text
on /wiki query <query>:
  search compiled Markdown pages
  filter to project_public pages and pages owned by requesting user_key
  rank by explicit title, headings, tags, and source refs
  return bounded excerpts with page paths
  include source refs where available

on normal message with explicit wiki context request:
  query wiki
  attach bounded results as data-only context
  escape command-like and system/developer/tool-like prefixes inside attached snippets
  label context as user-reviewable wiki knowledge, not system/developer/tool instruction
  start turn through existing Router
```

### Lint

```text
on /wiki lint:
  enumerate wiki pages and manifests
  validate Markdown links
  validate source refs still resolve or mark stale
  detect orphan pages
  flag pages missing source refs unless explicitly marked user_note
  scan for disallowed content candidates:
    conversation body replicas
    tool call payloads
    diffs
    approval histories
    Codex rollout JSONL fragments
  report findings as Markdown with paths, locations, finding kinds, hashes, and redacted/bounded snippets only
```

## Validation Criteria

- Task 1: docs define layout, page metadata, source refs, and forbidden content.
- Task 2: wiki is optional and fails closed on invalid config.
- Task 3: unsafe paths, traversal, and Codex rollout/session paths are rejected.
- Task 3: wiki queries and context attachment return only `project_public`
  pages and pages owned by the requesting `user_key`.
- Task 4: manifests are auditable and contain no hidden
  conversation/tool/diff payloads.
- Task 5: file ingest leaves raw sources untouched and creates linked Markdown
  artifacts.
- Task 6: user notes are explicit, inspectable, and marked as user-provided.
- Task 7: selected conversation workflow stores only user-requested summaries,
  not raw conversation bodies.
- Task 8: query returns bounded wiki excerpts with page/source references.
- Task 9: lint reports broken links, orphan pages, missing/stale refs, and
  disallowed-content candidates without copying forbidden matched content.
- Task 10: Router command integration does not regress existing commands.
- Task 11: attached wiki context is data-only and cannot modify Codex sandbox,
  approval policy, or AGENTS.md; command-like and system/developer/tool-like
  prefixes are escaped before attachment.
- Task 12: docs explain M3.5 without depending on Discord.
- Task 13: `bun run typecheck`, `bun test`, and manual checklist pass.

## Risks And Unknowns

- Unknown: exact best Markdown metadata format.
  - Smallest spike: create two sample pages and one manifest, then lint them
    with simple frontmatter parsing.
- Unknown: whether wiki metadata belongs in SQLite or only Markdown manifests.
  - Smallest spike: implement read-only manifest discovery prototype; add
    SQLite only if query or ownership lookups are too slow or awkward.
- Risk: accidental Codex rollout replication.
  - Smallest spike: add path denylist and lint fixture containing rollout-like
    JSONL; verify it is rejected or flagged without copying matched content into
    reports.
- Risk: prompt injection through wiki content.
  - Smallest spike: attach a malicious wiki fixture as context and verify the
    wrapper labels it as data-only and escapes command-like and
    system/developer/tool-like prefixes, similar to prefs.
- Risk: user-private wiki pages leak through shared project queries.
  - Smallest spike: create one `project_public` page and two user-private pages,
    then verify each user sees only public plus owned pages in query results and
    attached context.
- Unknown: contradiction lint quality.
  - Smallest spike: start with deterministic duplicate-title/source-staleness
    checks and report semantic contradictions only as conservative candidates.
- Risk: source refs become stale after file edits.
  - Smallest spike: compare stored content hash or mtime against current file
    and report stale refs without rewriting pages automatically.
- Risk: scope expands into a general knowledge base.
  - Smallest spike: keep commands limited to `ingest`, `note`,
    `capture-selected`, `query`, and `lint`; defer sync, sharing, embeddings,
    dashboards, and automation.

## Review History

- 2026-05-04: Initial plan proposal drafted read-only from `AGENTS.md`,
  workflows, roadmap M3.5, README vision/storage notes, PRD memory/storage
  sections, and current source layout.
- 2026-05-04: Implementation review round 1 found ownership leakage, lint report
  replication risk, selected-conversation capture ambiguity, rollout path escape
  hatches, context injection hardening gaps, and local summarizer scope leakage.
  Plan updated to require `project_public`/owner classification, redacted lint
  reports, hard rollout/session path denial, user-pasted or normal-Codex-summary
  capture only, prefs-like context sanitization, and Codex-only model-authored
  summarization.
