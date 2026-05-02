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
| `/tasks add <schedule> <label> <prompt>` | schedule, label, prompt | Creates a scheduled task bound to the named thread label without switching your active interactive thread. Schedules may be `every <n>s|m|h|d` or simple five-field cron. |
| `/tasks list` | none | Lists your scheduled tasks, next run time, and failure count. |
| `/tasks pause <id>` | task id | Pauses a scheduled task. |
| `/tasks reactivate <id>` | task id | Re-enables a scheduled task. |
| `/tasks remove <id>` | task id | Deletes a scheduled task definition. |
| `/prefs show` | none | Shows whitelisted user preferences. |
| `/prefs set <key> <value>` | key, value | Sets `lang`, `tone`, or `verbosity`. |
| `/prefs unset <key>` | key | Removes `lang`, `tone`, or `verbosity`. |

Labels use lowercase letters, numbers, `.`, `_`, and `-`; they must start with a
letter or number.

## Scheduler And Prefs Notes

- Scheduled tasks route through the same Router/Codex path as user messages.
- Task rows store definitions, including scheduled task instructions, and run
  metadata only. Treat task instructions as sensitive user content; Codex
  outputs, diffs, tool calls, approval histories, and conversation bodies stay
  out of codexclaw storage.
- Preferences are attached to turns as bounded user preference context. They do
  not change sandbox behavior, approval policy, model routing, channel
  authorization, or AGENTS.md trust boundaries.

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

## Discord Notes

- Discord DMs and bot mentions route by sender identity in personal mode.
- Signed Discord HTTP interactions are the trusted command, approval, Modify
  modal, and branch suggestion path.
- Gateway text is prompt text only; slash-looking gateway text is rejected and
  users should use Discord slash commands instead.
