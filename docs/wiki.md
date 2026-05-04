# Knowledge Wiki

The Knowledge Wiki is an optional Markdown workspace for fork-specific project
knowledge. It is designed to be inspectable with normal file tools and git.

## Storage Layout

- `wiki/pages/*.md`: compiled wiki pages with codexclaw frontmatter.
- `wiki/manifests/*.json`: ingest manifests with source references and hashes.
- `wiki/lint/*.md`: optional lint reports with redacted snippets only.

Raw repository sources remain where they are. `/wiki ingest` records source
references and hashes, but does not copy raw source text into hidden storage.

## Visibility

Every page is either:

- `project_public`: visible to every local user.
- `user_private`: visible only to the owning `user_key`.

Query and context attachment enforce this classification.

## Commands

```text
/wiki ingest [--public|--private] [--slug <slug>] <path...> [--focus <text>]
/wiki note [--public|--private] <title> <body>
/wiki capture-selected [--public|--private] [--slug <slug>] <selected text>
/wiki query [--limit <n>] <query>
/wiki with [--limit <n>] <query> -- <message>
/wiki lint [--write-report]
```

`capture-selected` accepts only user-provided selected text. codexclaw must not
scan Codex rollout files, call turn-reading APIs to retrieve raw prior turns, or
scrape channel logs to create wiki entries.

## Boundaries

The wiki must not persist:

- conversation bodies;
- tool calls;
- diffs or patches;
- approval histories;
- Codex rollout/session replicas;
- raw Codex event payloads.

Lint reports must not copy forbidden matched content. They may include finding
kinds, page paths, locations, hashes, and redacted bounded snippets.

Wiki context attached to a turn is data only. It is sanitized for command-like
and system/developer/tool/approval/sandbox-like prefixes before it is included
in user input. It cannot change Codex sandbox, approval, model routing, or
AGENTS.md policy.
