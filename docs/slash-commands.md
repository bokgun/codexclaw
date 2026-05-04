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
- The canonical codexclaw command syntax remains `/...` across CLI, Telegram,
  and Discord signed slash commands.
- For local personal Discord bots, DM text and mentioned guild text may use
  `:command` as a convenience alias. The adapter converts it to the shared
  router command before execution. For example, `:threads` is routed as
  `/threads`, and `@bot :switch work` is routed as `/switch work`.
- Gateway text is prompt text only; slash-looking gateway text is rejected and
  users should use a registered Discord slash command, a `:command` local
  shortcut, or normal prompt text without a leading slash.

### Discord Local Command Shortcut

The `:` shortcut avoids the HTTPS tunnel and command-registration setup needed
for real Discord slash commands while keeping Router behavior centralized.

| Discord text | Router input |
| --- | --- |
| `:threads` | `/threads` |
| `:new work` | `/new work` |
| `:switch work` | `/switch work` |
| `:tasks list` | `/tasks list` |
| `:prefs show` | `/prefs show` |

In guild channels, the bot must still be mentioned first:

```text
@CodexClawApp :threads
```

Text that does not look like a command alias, such as `:)`, remains normal
prompt text.

### Discord Local Interaction Fallback

Discord buttons and real slash commands use signed HTTP interactions, so they
need the Interactions Endpoint URL setup below. For local personal bots,
codexclaw also accepts text replies for the common button flows:

Approval prompts:

| Discord text | Decision |
| --- | --- |
| `1` or `:approve` | approve |
| `2` or `:reject` | reject |
| `3 <instruction>` or `:modify <instruction>` | modify |

Branch suggestions:

| Discord text | Decision |
| --- | --- |
| `1` or `:new` | start a new thread |
| `2` or `:continue` | continue in the current thread |

The signed button path remains available when a public interaction endpoint is
configured. The text fallback is intended for local development and personal
Discord bots where setting up an HTTPS tunnel would otherwise block approvals.

### Discord Slash Command Setup

Discord slash commands require more setup than plain DM prompts because the
commands must be registered with Discord and delivered to codexclaw as signed
HTTP interactions.

1. Start Codex app-server in one terminal:

   ```bash
   bun run start:codex
   ```

2. Start the Discord runtime in another terminal:

   ```bash
   bun run discord
   ```

   By default, codexclaw listens for Discord interactions at:

   ```text
   http://127.0.0.1:8787/discord/interactions
   ```

3. Expose the local interaction receiver through an HTTPS tunnel. For example,
   with ngrok:

   ```bash
   ngrok http 8787
   ```

   Or with Cloudflare Tunnel:

   ```bash
   cloudflared tunnel --url http://127.0.0.1:8787
   ```

4. In Discord Developer Portal, open the application and set the Interactions
   Endpoint URL to the tunnel URL plus the codexclaw path:

   ```text
   https://example-tunnel.ngrok-free.app/discord/interactions
   ```

   Keep `bun run discord` running while saving this setting. Discord sends a
   verification request immediately, and codexclaw must be online to answer it.

5. Register Discord application commands. During development, guild commands are
   easiest because they appear quickly in a single test server. Global commands
   are better for DM use, but can take longer to propagate.

   The current Discord adapter converts signed application commands into the
   shared router's text format. For example:

   ```text
   Discord /switch label:work
   -> codexclaw /switch work
   ```

   Thread commands such as `/threads`, `/new`, `/switch`, `/archive`, and
   `/branch` are straightforward to register. Nested commands such as
   `/tasks add ...` and `/prefs set ...` should be registered with options that
   flatten to the shared router syntax.

6. Test in Discord. If typing `/threads` sends a normal DM and returns a notice
   that the message was not a signed app command, the command is not registered
   or Discord has not propagated it yet. Registered commands should appear in
   Discord's slash command picker and arrive as signed interactions. For local
   personal bots, `:threads` remains available as a text shortcut even when
   signed slash commands are not configured.
