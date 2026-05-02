# Slash Commands

codexclaw slash commands are handled by the shared router. Telegram and CLI use
the same command set unless a command is explicitly marked channel-specific.

## Current Commands

| Command | Arguments | What It Does |
| --- | --- | --- |
| `/threads` | none | Lists your known threads. The active thread is marked with `*`, and each row shows the thread label and status. |
| `/new` | optional label | Creates a new Codex thread and switches your active thread to it. Without a label, codexclaw generates one. |
| `/new <label>` | label | Creates a new named thread and switches to it. Duplicate labels are rejected. |
| `/switch <label>` | label | Switches your active thread to an existing label. |
| `/branch` | optional label | Attempts to fork the active thread into a new branch and switches to it. If `thread/fork` is not enabled, this returns a capability error. |
| `/branch <label>` | label | Attempts to fork the active thread into the given label. Duplicate labels are rejected before forking. |
| `/archive <label>` | label | Attempts to archive the named thread. If `thread/archive` is not enabled, this returns a capability error. |

Labels use lowercase letters, numbers, `.`, `_`, and `-`; they must start with a
letter or number.

## Telegram Notes

- Telegram M2 supports private chats only.
- Telegram passes slash commands to the shared router; it does not implement a
  separate Telegram command parser.
- `/start` is not a codexclaw command yet, so it currently returns
  `Unknown command '/start'.`
- `/quit` and `/exit` are not Telegram commands and do not stop the host.
- Branch suggestion buttons may internally route `/new` before replaying the
  held message, but users do not need to type a special command for that flow.

## CLI Notes

- `/quit` and `/exit` are CLI-only host controls.
- CLI approval prompts also accept approval-specific shortcuts such as `1`,
  `2`, and `3 <instruction>`. These are approval prompt inputs, not router slash
  commands.

## Planned Commands

These are described in the PRD but are not implemented yet:

| Command | Planned Purpose |
| --- | --- |
| `/prefs show` | Show user preferences. |
| `/prefs set <key> <value>` | Set whitelisted preferences such as `lang`, `tone`, or `verbosity`. |
| `/prefs unset <key>` | Remove a preference. |

Preferences are intended for lightweight user customization only. They must not
change Codex sandbox behavior, approval policy, or AGENTS.md trust boundaries.
