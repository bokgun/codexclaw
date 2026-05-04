# M3.5 Manual Checklist

## Setup

- Enable the wiki in `.env`:

  ```bash
  CODEXCLAW_WIKI_ENABLED=true
  CODEXCLAW_WIKI_ROOT=wiki
  CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS=docs,README.md
  ```

- Start Codex app-server and CLI:

  ```bash
  bun run start:codex
  bun run cli
  ```

## Wiki Commands

- Run `/wiki ingest --public --slug roadmap docs/ROADMAP.md`.
- Confirm `wiki/pages/roadmap.md` and a manifest under `wiki/manifests/` are
  created.
- Confirm the page references `docs/ROADMAP.md` but does not copy raw source
  content into hidden storage.
- Run `/wiki note private-note Remember source-first wiki design`.
- Confirm the page is `user_private`.
- Run `/wiki query roadmap`.
- Confirm query results show public pages and do not expose another user's
  private pages in tests.
- Run `/wiki capture-selected --slug selected-summary selected summary text`.
- Confirm the stored page says the raw conversation remains in Codex rollout
  storage.
- Run `/wiki lint --write-report`.
- Confirm lint reports contain redacted snippets and do not copy forbidden
  matched content.

## Boundary Checks

- Attempt to ingest `.codex/sessions/example.jsonl`; it must be rejected.
- Attempt to ingest a path outside `CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS`; it
  must be rejected.
- Confirm no command directly edits `AGENTS.md`.
- Confirm wiki context is treated as data only and cannot change sandbox,
  approval, model routing, or AGENTS.md policy.
