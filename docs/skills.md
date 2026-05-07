# Skills Inspection

M4c exposes a read-only skills inspection surface. codexclaw asks Codex
app-server for `skills/list`, normalizes the metadata for channel display, and
keeps the result in process memory only. It does not scan `SKILL.md` files,
execute skills, install plugins, write skill config, or persist skill metadata.

## Codex Skills

Codex owns skill discovery and `SKILL.md` parsing. codexclaw calls:

```text
skills/list { cwds: [workspaceRoot] }
```

When Codex sends `skills/changed`, codexclaw treats it as cache invalidation
only. It does not fetch immediately and does not call `skills/config/write`.

Channel output includes only bounded metadata:

- family: `codex`
- scope: `user`, `repo`, `system`, or `admin`
- enabled state
- name and description
- workspace-relative, home-relative, or redacted source labels
- bounded per-cwd errors

codexclaw omits dependency command bodies, dependency URLs, generated interface
default prompts, and raw private absolute paths.

## Host Skills

Host skills are static codexclaw capability metadata. They describe channel
adapters, scheduler visibility, wiki commands, runtime host metadata, and a
disabled installer placeholder for post-M4 work. Each host entry has the
boundary `metadata_only`.

Host entries are not executable skills and do not grant permissions. Approval,
sandbox, model routing, tool execution, and rollout storage remain Codex-owned.

## Wiki Relation

The wiki is listed as a host capability because codexclaw owns wiki command
metadata and routing. Wiki content is user-managed context. It is separate from
Codex skills and is not converted into skill metadata.

## Future UX

Post-M4 work may add skill selection or installer flows. Those flows must keep
Codex as the owner of skill execution/configuration and preserve the existing
sandbox and approval behavior.
