# Logging

codexclaw runtime logs are JSON lines written to stderr. Each log call writes one JSON object followed by a newline.

## Configuration

```env
CODEXCLAW_LOG_LEVEL=info
CODEXCLAW_LOG_FORMAT=json
```

`CODEXCLAW_LOG_LEVEL` accepts `debug`, `info`, `warn`, or `error`; the default is `info`. `CODEXCLAW_LOG_FORMAT=json` and `LOG_FORMAT=json` are accepted, but JSON is the only supported runtime format. Any other format value fails startup.

## Record Shape

Stable fields:

- `ts`: ISO timestamp.
- `level`: `debug`, `info`, `warn`, or `error`.
- `event`: short event name.

Additional fields are bounded, redacted JSON metadata. Ordinary strings are redacted and capped, arrays are summarized by length, and deeply nested or very wide objects are truncated. Example:

```json
{"ts":"2026-05-07T00:00:00.000Z","level":"info","event":"runtime.started","adapter":"cli"}
```

Logs are for operations and diagnostics. They are not a transcript store.

## Redaction And Content Rules

Field names containing token, secret, password, authorization, credential, cookie, API key, or signing are replaced with `[redacted]`. Secret-like strings such as bearer tokens, bot tokens, OpenAI-style API keys, GitHub tokens, Slack tokens, token query parameters, and `KEY=value` secret assignments are redacted inside ordinary string fields.

Content-like fields are summarized instead of logged raw when their key ends in text, prompt, content, body, diff, patch, command, args, output, transcript, or message. Strings become content summaries with lengths; arrays and objects become shape summaries. Arrays under other keys are logged as `{ "kind": "array", "length": n }`. Generic string fields are capped at 1,000 characters, objects are capped at 32 keys per level, and nesting is capped at four object levels.

Do not add logs that emit raw prompts, raw message bodies, raw conversation bodies, raw diffs, raw patches, raw command strings, raw tool arguments, raw tool output, bearer tokens, channel bot tokens, or approval histories. codexclaw stores only its own routing metadata; Codex rollout storage remains the source of truth for conversation content, tool calls, diffs, and approval records.

## Collection

Because logs go to stderr, process managers can collect them without changing application code. Keep stderr access restricted like other operational data: logs may contain file paths, event names, thread ids, adapter ids, and summarized content lengths even after redaction.
