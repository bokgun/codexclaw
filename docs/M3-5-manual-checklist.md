# M3.5 Manual Checklist

Use this checklist to validate the optional Knowledge Wiki after local setup or
before cutting an M3.5 release.

## 1. Setup

- [ ] Install dependencies with `bun install` if needed.
- [ ] Confirm `.env` enables the wiki:

  ```bash
  CODEXCLAW_WIKI_ENABLED=true
  CODEXCLAW_WORKSPACE_ROOT=/path/to/project
  CODEXCLAW_WIKI_ROOT=wiki
  CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS=docs,README.md
  ```

- [ ] Confirm `CODEXCLAW_WORKSPACE_ROOT` points at the project Codex should
  inspect and edit.
- [ ] Confirm `CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS` includes only source paths
  that are safe to summarize into wiki pages.
- [ ] Start Codex app-server:

  ```bash
  bun run start:codex
  ```

- [ ] In another terminal, start a local channel, for example:

  ```bash
  bun run cli
  ```

## 2. Basic Commands

- [ ] Run:

  ```text
  /wiki ingest --public --slug roadmap docs/ROADMAP.md
  ```

- [ ] Confirm `wiki/pages/roadmap.md` is created.
- [ ] Confirm a corresponding manifest appears under `wiki/manifests/`.
- [ ] Confirm the page frontmatter has `visibility: project_public`.
- [ ] Confirm the manifest records source references and hashes, not hidden
  copies of raw source content.
- [ ] Run:

  ```text
  /wiki note --private private-note Remember source-first wiki design
  ```

- [ ] Confirm the note page is created with `visibility: user_private`.
- [ ] Confirm the note page includes an owner key.
- [ ] Run:

  ```text
  /wiki capture-selected --private --slug selected-summary selected summary text
  ```

- [ ] Confirm the captured page says raw conversation remains in Codex rollout
  storage.
- [ ] Confirm the captured page does not claim codexclaw scanned prior turns or
  channel logs.

## 3. Query And Context

- [ ] Run:

  ```text
  /wiki query roadmap
  ```

- [ ] Confirm results include the public roadmap page.
- [ ] Confirm results show relative wiki page paths such as `pages/roadmap.md`,
  not absolute local paths.
- [ ] Confirm another user's private pages are not returned. This can be checked
  through tests if only one local user is available.
- [ ] Run:

  ```text
  /wiki with roadmap -- Summarize the project direction in two bullets.
  ```

- [ ] Confirm Codex receives relevant wiki context and answers the prompt.
- [ ] Confirm attached wiki context is treated as data only and does not change
  sandbox, approval, model routing, or AGENTS.md policy.

## 4. Lint

- [ ] Run:

  ```text
  /wiki lint
  ```

- [ ] Confirm lint output reports any forbidden payload findings without copying
  sensitive content.
- [ ] Run:

  ```text
  /wiki lint --write-report
  ```

- [ ] Confirm a report is created under `wiki/lint/`.
- [ ] Confirm the report includes `codexclawWikiLint: v1`, `visibility:
  user_private`, `ownerUserKey`, and `generatedAt` frontmatter.
- [ ] Confirm lint reports contain redacted snippets only.

## 5. Boundary Checks

- [ ] Attempt to ingest a Codex rollout/session file such as:

  ```text
  /wiki ingest .codex/sessions/example.jsonl
  ```

- [ ] Confirm the command is rejected.
- [ ] Attempt to ingest a path outside `CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS`.
- [ ] Confirm the command is rejected.
- [ ] Attempt to store obvious forbidden text through `/wiki note`,
  `/wiki capture-selected`, or `/wiki ingest --focus`.
- [ ] Confirm the command is rejected before writing a page.
- [ ] Confirm no wiki command directly edits `AGENTS.md`.
- [ ] Confirm source refs for exact allowed file roots, such as `README.md`, do
  not leak absolute display paths.
- [ ] Confirm symlinked wiki page files or symlinked wiki directories are not
  followed for reads or writes.

## 6. Regression Commands

- [ ] Run:

  ```bash
  bun run typecheck
  ```

- [ ] Confirm typecheck passes.
- [ ] Run:

  ```bash
  bun test
  ```

- [ ] Confirm all tests pass.
- [ ] Confirm wiki-related tests cover config parsing, command parsing, query
  filtering, context attachment, path safety, and forbidden persistence checks.

## 7. Cleanup

- [ ] Review generated `wiki/` files before committing. Keep only intentional
  sample pages or reports.
- [ ] Confirm `git status --short` contains only expected changes.
