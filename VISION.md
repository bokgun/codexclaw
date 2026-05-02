# Vision

codexclaw is a forkable seed for building customized Codex-powered agents.

It provides adapters, routing, lightweight memory, schedules, and preferences
while delegating reasoning, tool execution, patches, approvals, and rollout
storage to Codex.

## Product Direction

codexclaw should feel easy to fork and reshape into a personal or team-specific
agent host. The project owns the shell around Codex: channel adapters, routing
rules, thread pointers, labels, schedules, pending approval mappings, and user
preferences.

The project should not become a replacement for Codex. Editing, patching, model
routing, sandbox decisions, approval enforcement, conversation bodies, tool
calls, diffs, and approval histories remain Codex responsibilities.

## Customization Surface

- Agent profiles: prompts, preferences, and operating style.
- Channel adapters: CLI, Telegram, Discord, and future chat surfaces.
- Routing behavior: how incoming messages map to Codex threads.
- Lightweight memory: codexclaw-owned pointers, labels, schedules, and prefs.
- Local workflows: scripts and docs that help a fork become its own agent host.

## Knowledge Wiki

codexclaw treats customization knowledge as a maintained wiki, not hidden
memory. A fork can add raw sources, conventions, prompts, and project notes,
then let the agent compile them into linked Markdown pages that humans can
inspect, edit, version, and review.

This wiki layer should follow a source-first shape:

- Raw sources remain untouched and human-auditable.
- Compiled wiki pages are LLM-maintained Markdown artifacts.
- Schema and instruction files define conventions for ingest, query, and lint.
- The user steers what should be remembered, updated, or corrected.

The wiki must not become a shadow copy of Codex rollout storage. Conversation
bodies, tool calls, diffs, and approval histories remain Codex-owned unless a
user explicitly asks the agent to summarize selected knowledge into the wiki.
