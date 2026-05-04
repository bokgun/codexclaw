import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDiscordConfig,
  getRuntimePathConfig,
  getTelegramConfig,
  getWikiConfig,
  redactDiscordSecrets,
  redactTelegramSecrets
} from "../../src/config/env.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("Runtime path config", () => {
  test("defaults state under the workspace and resolves explicit paths from the workspace", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = ".state/codexclaw";
    process.env.CODEXCLAW_DB = ".state/codexclaw/pointers.sqlite";

    const config = getRuntimePathConfig();

    expect(config.workspaceRoot).toBe(workspace);
    expect(config.stateDir).toBe(join(workspace, ".state/codexclaw"));
    expect(config.dbPath).toBe(join(workspace, ".state/codexclaw/pointers.sqlite"));
  });

  test("rejects a workspace root that is not a directory", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = join(workspace, "missing");

    expect(() => getRuntimePathConfig()).toThrow("CODEXCLAW_WORKSPACE_ROOT");
  });
});

describe("Telegram config", () => {
  test("requires a bot token and allowlisted numeric user ids", () => {
    process.env.CODEXCLAW_TELEGRAM_BOT_TOKEN = "";
    process.env.CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS = "";
    expect(() => getTelegramConfig()).toThrow("CODEXCLAW_TELEGRAM_BOT_TOKEN");

    process.env.CODEXCLAW_TELEGRAM_BOT_TOKEN = "123:secret";
    process.env.CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS = "42,not-a-number";
    expect(() => getTelegramConfig()).toThrow("numeric Telegram user ids");

    process.env.CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS = "42, 43";
    const config = getTelegramConfig();
    expect(config.allowedUserIds).toEqual(["42", "43"]);
    expect(config.allowAllUsersForLocalDev).toBe(false);
  });

  test("redacts bot tokens in Telegram API errors", () => {
    expect(redactTelegramSecrets("https://api.telegram.org/bot123:secret/sendMessage failed", "123:secret")).toBe(
      "https://api.telegram.org/bot[telegram-bot-token]/sendMessage failed"
    );
    expect(redactTelegramSecrets("token 123:secret leaked", "123:secret")).toBe("token [telegram-bot-token] leaked");
  });
});

describe("Discord config", () => {
  test("requires bot token, application id, public key, and allowed users", () => {
    process.env.CODEXCLAW_DISCORD_BOT_TOKEN = "";
    process.env.CODEXCLAW_DISCORD_APPLICATION_ID = "123";
    process.env.CODEXCLAW_DISCORD_PUBLIC_KEY = "a".repeat(64);
    process.env.CODEXCLAW_DISCORD_ALLOWED_USER_IDS = "42";
    expect(() => getDiscordConfig()).toThrow("CODEXCLAW_DISCORD_BOT_TOKEN");

    process.env.CODEXCLAW_DISCORD_BOT_TOKEN = "secret-token";
    process.env.CODEXCLAW_DISCORD_APPLICATION_ID = "not-a-snowflake";
    expect(() => getDiscordConfig()).toThrow("CODEXCLAW_DISCORD_APPLICATION_ID");

    process.env.CODEXCLAW_DISCORD_APPLICATION_ID = "123";
    process.env.CODEXCLAW_DISCORD_PUBLIC_KEY = "not-hex";
    expect(() => getDiscordConfig()).toThrow("CODEXCLAW_DISCORD_PUBLIC_KEY");

    process.env.CODEXCLAW_DISCORD_PUBLIC_KEY = "a".repeat(64);
    process.env.CODEXCLAW_DISCORD_ALLOWED_USER_IDS = "42, not-a-user";
    expect(() => getDiscordConfig()).toThrow("CODEXCLAW_DISCORD_ALLOWED_USER_IDS");

    process.env.CODEXCLAW_DISCORD_ALLOWED_USER_IDS = "42, 43";
    process.env.CODEXCLAW_DISCORD_ALLOWED_GUILD_IDS = "900";
    const config = getDiscordConfig();
    expect(config.allowedUserIds).toEqual(["42", "43"]);
    expect(config.allowedGuildIds).toEqual(["900"]);
    expect(config.interactionsPath).toBe("/discord/interactions");
  });

  test("redacts Discord bot tokens in API errors", () => {
    expect(redactDiscordSecrets("Authorization failed for Bot secret-token", "secret-token")).toBe(
      "Authorization failed for Bot [discord-bot-token]"
    );
    expect(redactDiscordSecrets("token secret-token leaked", "secret-token")).toBe("token [discord-bot-token] leaked");
  });

  test("validates Discord Gateway URL before sending bot tokens", () => {
    process.env.CODEXCLAW_DISCORD_BOT_TOKEN = "secret-token";
    process.env.CODEXCLAW_DISCORD_APPLICATION_ID = "123";
    process.env.CODEXCLAW_DISCORD_PUBLIC_KEY = "a".repeat(64);
    process.env.CODEXCLAW_DISCORD_ALLOWED_USER_IDS = "42";

    process.env.CODEXCLAW_DISCORD_GATEWAY_URL = "ws://example.com/gateway";
    expect(() => getDiscordConfig()).toThrow("CODEXCLAW_DISCORD_GATEWAY_URL must use wss://");

    process.env.CODEXCLAW_DISCORD_GATEWAY_URL = "wss://user@example.com/gateway";
    expect(() => getDiscordConfig()).toThrow("must not include credentials");

    process.env.CODEXCLAW_DISCORD_GATEWAY_URL = "ws://127.0.0.1:9000/gateway";
    expect(getDiscordConfig().gatewayUrl).toBe("ws://127.0.0.1:9000/gateway");
  });
});

describe("Wiki config", () => {
  test("loads optional wiki settings with bounded limits", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_WIKI_ENABLED = "true";
    process.env.CODEXCLAW_WIKI_ROOT = "knowledge";
    process.env.CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS = "docs,README.md";
    process.env.CODEXCLAW_WIKI_MAX_SOURCE_BYTES = "4096";
    process.env.CODEXCLAW_WIKI_MAX_QUERY_RESULTS = "3";
    process.env.CODEXCLAW_WIKI_MAX_EXCERPT_CHARS = "300";

    const config = getWikiConfig();

    expect(config).toEqual({
      enabled: true,
      wikiRoot: join(workspace, "knowledge"),
      allowedSourceRoots: [join(workspace, "docs"), join(workspace, "README.md")],
      maxSourceBytes: 4096,
      maxQueryResults: 3,
      maxExcerptChars: 300
    });
  });

  test("rejects out-of-range wiki limits", () => {
    process.env.CODEXCLAW_WIKI_MAX_QUERY_RESULTS = "100";
    expect(() => getWikiConfig()).toThrow("CODEXCLAW_WIKI_MAX_QUERY_RESULTS");
  });
});
