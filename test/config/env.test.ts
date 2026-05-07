import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCodexConnectionConfig,
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
  test("defaults state under the workspace and resolves explicit paths from the state dir", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = ".state/codexclaw";
    process.env.CODEXCLAW_DB = "pointers.sqlite";

    const config = getRuntimePathConfig();

    expect(config.workspaceRoot).toBe(workspace);
    expect(config.stateDir).toBe(join(workspace, ".state/codexclaw"));
    expect(config.dbPath).toBe(join(workspace, ".state/codexclaw/pointers.sqlite"));
  });

  test("creates missing workspace and state directories", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const workspaceRoot = join(workspace, "missing", "project");
    const stateDir = join(workspace, "state", "project");
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspaceRoot;
    process.env.CODEXCLAW_STATE_DIR = stateDir;

    const config = getRuntimePathConfig();

    expect(config.workspaceRoot).toBe(workspaceRoot);
    expect(config.stateDir).toBe(stateDir);
    expect(existsSync(workspaceRoot)).toBe(true);
    expect(existsSync(stateDir)).toBe(true);
    expect(statSync(stateDir).mode & 0o077).toBe(0);
  });

  test("resolves tilde-prefixed state paths from the user home", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-home-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = "~/.codexclaw/project";

    const config = getRuntimePathConfig();

    expect(config.stateDir).toBe(join(home, ".codexclaw/project"));
    expect(existsSync(config.stateDir)).toBe(true);
    process.env.HOME = previousHome;
  });

  test("resolves relative token and db paths from the state dir", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = join(workspace, ".state");
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;
    process.env.CODEXCLAW_CODEX_TOKEN_FILE = "tokens/codex.token";
    process.env.CODEXCLAW_DB = "db/codexclaw.sqlite";

    const paths = getRuntimePathConfig();
    const codex = getCodexConnectionConfig();

    expect(paths.dbPath).toBe(join(stateDir, "db/codexclaw.sqlite"));
    expect(codex.tokenFile).toBe(join(stateDir, "tokens/codex.token"));
    expect(existsSync(codex.tokenFile)).toBe(true);
  });

  test("maps legacy .codexclaw token and db paths into the state dir", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = join(workspace, ".state");
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;
    process.env.CODEXCLAW_CODEX_TOKEN_FILE = ".codexclaw/codex.token";
    process.env.CODEXCLAW_DB = ".codexclaw/codexclaw.sqlite";

    const paths = getRuntimePathConfig();
    const codex = getCodexConnectionConfig();

    expect(paths.dbPath).toBe(join(stateDir, "codexclaw.sqlite"));
    expect(codex.tokenFile).toBe(join(stateDir, "codex.token"));
  });

  test("maps legacy .codexclaw/codexclaw.db to the default sqlite path", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = join(workspace, ".state");
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;
    process.env.CODEXCLAW_DB = ".codexclaw/codexclaw.db";

    const paths = getRuntimePathConfig();

    expect(paths.dbPath).toBe(join(stateDir, "codexclaw.sqlite"));
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
    process.env.CODEXCLAW_STATE_DIR = join(workspace, ".state");
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
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = join(workspace, ".state");
    process.env.CODEXCLAW_WIKI_MAX_QUERY_RESULTS = "100";
    expect(() => getWikiConfig()).toThrow("CODEXCLAW_WIKI_MAX_QUERY_RESULTS");
  });
});
