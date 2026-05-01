# M2 Telegram Manual Verification Checklist

Use this after `bun run typecheck` and `bun test` pass. Telegram M2 uses long
polling and private personal chats only; no webhook secret token is used in this
mode.

## Setup

1. Create a Telegram bot with BotFather and collect the bot token.
2. Find your numeric Telegram user id.
3. Add local environment values:

   ```bash
   CODEXCLAW_TELEGRAM_BOT_TOKEN=123456:bot-token
   CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS=123456789
   CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500
   CODEXCLAW_CODEX_TOKEN_FILE=.codexclaw/codex.token
   ```

4. Start Codex app-server and the Telegram runtime:

   ```bash
   bun run start:codex
   bun run telegram
   ```

## Expected Behavior

- A text message in a private chat routes to the active personal Codex thread.
- Slash commands such as `/threads` and `/new` are passed as text to the shared
  router.
- Group, supergroup, and channel messages are rejected with a private-chat-only
  notice and do not route.
- Messages from users not listed in `CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS` are
  rejected before routing.
- Agent deltas are coalesced into readable Telegram messages instead of one
  message per token.
- Long responses are split below Telegram message limits.
- Approval prompts show inline `Approve`, `Reject`, and `Modify` buttons.
- `Approve` and `Reject` answer the callback and resolve the pending Codex
  approval.
- `Modify` immediately rejects the original approval through core delayed Modify
  state, asks for a reply with changed instructions, then submits that reply as
  the follow-up instruction if it arrives before timeout.

## Security Notes

- Bot tokens stay in Telegram runtime configuration and are not passed to Codex
  app-server as turn input or tool environment.
- Callback data contains only opaque short keys plus an action name.
- Long-polling offsets and Telegram callback correlation state are in memory
  only. After restart, Telegram may replay the last unconfirmed update, and old
  callbacks answer as expired or unknown.
