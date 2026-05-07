import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
const ISOLATED_CODEXCLAW_ENV_KEYS = [
  "CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE",
  "CODEXCLAW_CODEX_TOKEN_FILE",
  "CODEXCLAW_CODEX_WS",
  "CODEXCLAW_DB",
  "CODEXCLAW_DEPLOYMENT_MODE",
  "CODEXCLAW_DISCORD_ALLOWED_GUILD_IDS",
  "CODEXCLAW_DISCORD_ALLOWED_USER_IDS",
  "CODEXCLAW_DISCORD_API_BASE_URL",
  "CODEXCLAW_DISCORD_APPLICATION_ID",
  "CODEXCLAW_DISCORD_BOT_TOKEN",
  "CODEXCLAW_DISCORD_GATEWAY_URL",
  "CODEXCLAW_DISCORD_INTERACTIONS_HOST",
  "CODEXCLAW_DISCORD_INTERACTIONS_PATH",
  "CODEXCLAW_DISCORD_INTERACTIONS_PORT",
  "CODEXCLAW_DISCORD_PUBLIC_KEY",
  "CODEXCLAW_STATE_DIR",
  "CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS",
  "CODEXCLAW_TELEGRAM_API_BASE_URL",
  "CODEXCLAW_TELEGRAM_BOT_TOKEN",
  "CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS",
  "CODEXCLAW_WIKI_ENABLED",
  "CODEXCLAW_WIKI_MAX_EXCERPT_CHARS",
  "CODEXCLAW_WIKI_MAX_QUERY_RESULTS",
  "CODEXCLAW_WIKI_MAX_SOURCE_BYTES",
  "CODEXCLAW_WIKI_ROOT",
  "CODEXCLAW_WORKSPACE_ROOT"
] as const;

function resetCodexclawEnv(): void {
  for (const key of ISOLATED_CODEXCLAW_ENV_KEYS) process.env[key] = "";
}

function isolatedTest(name: string, fn: () => void | Promise<void>): void {
  test(name, () => {
    resetCodexclawEnv();
    return fn();
  });
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("Runtime path config", () => {
  isolatedTest("defaults state outside the workspace in local_loopback mode", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-home-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    process.env.HOME = home;
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;

    const config = getRuntimePathConfig();

    expect(config.workspaceRoot).toBe(workspace);
    expect(config.stateDir).toBe(join(home, ".codexclaw"));
    expect(config.dbPath).toBe(join(home, ".codexclaw/codexclaw.sqlite"));
    expect(config.deploymentMode).toBe("local_loopback");
    expect(config.allowWorkspaceInternalState).toBe(false);
  });

  isolatedTest("resolves explicit workspace-internal paths only with local_dev opt-in", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_DEPLOYMENT_MODE = "local_dev";
    process.env.CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE = "true";
    process.env.CODEXCLAW_STATE_DIR = ".state/codexclaw";
    process.env.CODEXCLAW_DB = "pointers.sqlite";

    const config = getRuntimePathConfig();

    expect(config.workspaceRoot).toBe(workspace);
    expect(config.stateDir).toBe(join(workspace, ".state/codexclaw"));
    expect(config.dbPath).toBe(join(workspace, ".state/codexclaw/pointers.sqlite"));
  });

  isolatedTest("rejects unknown deployment modes and workspace-internal state by default", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_DEPLOYMENT_MODE = "bad";
    expect(() => getRuntimePathConfig()).toThrow("CODEXCLAW_DEPLOYMENT_MODE");

    process.env.CODEXCLAW_DEPLOYMENT_MODE = "local_loopback";
    process.env.CODEXCLAW_STATE_DIR = ".codexclaw";
    expect(() => getRuntimePathConfig()).toThrow("CODEXCLAW_STATE_DIR must stay outside");

    process.env.CODEXCLAW_STATE_DIR = stateDir;
    process.env.CODEXCLAW_DB = join(workspace, "codexclaw.sqlite");
    expect(() => getRuntimePathConfig()).toThrow("CODEXCLAW_DB must stay outside");

    process.env.CODEXCLAW_DB = "";
    process.env.CODEXCLAW_CODEX_TOKEN_FILE = join(workspace, "codex.token");
    expect(() => getCodexConnectionConfig()).toThrow("CODEXCLAW_CODEX_TOKEN_FILE must stay outside");
  });

  isolatedTest("rejects token and database paths outside the private state dir by default", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    const other = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-other-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;

    process.env.CODEXCLAW_CODEX_TOKEN_FILE = join(other, "codex.token");
    expect(() => getCodexConnectionConfig()).toThrow("CODEXCLAW_CODEX_TOKEN_FILE must stay inside");

    delete process.env.CODEXCLAW_CODEX_TOKEN_FILE;
    process.env.CODEXCLAW_DB = join(other, "codexclaw.sqlite");
    expect(() => getRuntimePathConfig()).toThrow("CODEXCLAW_DB must stay inside");
  });

  isolatedTest("creates missing workspace and state directories", () => {
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

  isolatedTest("resolves tilde-prefixed state paths from the user home", () => {
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

  isolatedTest("resolves relative token and db paths from the state dir", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
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

  isolatedTest("maps legacy .codexclaw token and db paths into the state dir", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;
    process.env.CODEXCLAW_CODEX_TOKEN_FILE = ".codexclaw/codex.token";
    process.env.CODEXCLAW_DB = ".codexclaw/codexclaw.sqlite";

    const paths = getRuntimePathConfig();
    const codex = getCodexConnectionConfig();

    expect(paths.dbPath).toBe(join(stateDir, "codexclaw.sqlite"));
    expect(codex.tokenFile).toBe(join(stateDir, "codex.token"));
  });

  isolatedTest("maps legacy .codexclaw/codexclaw.db to the default sqlite path", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;
    process.env.CODEXCLAW_DB = ".codexclaw/codexclaw.db";

    const paths = getRuntimePathConfig();

    expect(paths.dbPath).toBe(join(stateDir, "codexclaw.sqlite"));
  });

  isolatedTest("rejects token, state directory, and database symlinks", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    const target = join(stateDir, "target");
    const stateLink = join(tmpdir(), `codexclaw-state-link-${Date.now()}`);
    symlinkSync(stateDir, stateLink, "dir");
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateLink;
    expect(() => getRuntimePathConfig()).toThrow("Refusing symlink CODEXCLAW_STATE_DIR");

    delete process.env.CODEXCLAW_STATE_DIR;
    process.env.CODEXCLAW_STATE_DIR = stateDir;
    writeFileSync(target, "secret\n", { mode: 0o600 });
    const tokenLink = join(stateDir, "token-link");
    symlinkSync(target, tokenLink);
    process.env.CODEXCLAW_CODEX_TOKEN_FILE = tokenLink;
    expect(() => getCodexConnectionConfig()).toThrow("symlink token file");

    delete process.env.CODEXCLAW_CODEX_TOKEN_FILE;
    const dbLink = join(stateDir, "db-link.sqlite");
    symlinkSync(target, dbLink);
    process.env.CODEXCLAW_DB = dbLink;
    expect(() => getRuntimePathConfig()).toThrow("symlink CODEXCLAW_DB");
  });

  isolatedTest("rejects state paths that resolve into the workspace through a symlinked parent", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-outside-")));
    const parentLink = join(outside, "workspace-link");
    symlinkSync(workspace, parentLink, "dir");
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = join(parentLink, "state");

    expect(() => getRuntimePathConfig()).toThrow("CODEXCLAW_STATE_DIR must stay outside");
  });

  isolatedTest("rejects missing token and database paths through symlinked parents into the workspace", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    const parentLink = join(stateDir, "workspace-link");
    symlinkSync(workspace, parentLink, "dir");
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;

    process.env.CODEXCLAW_CODEX_TOKEN_FILE = join(parentLink, "missing.token");
    expect(() => getCodexConnectionConfig()).toThrow("CODEXCLAW_CODEX_TOKEN_FILE must stay outside");

    delete process.env.CODEXCLAW_CODEX_TOKEN_FILE;
    process.env.CODEXCLAW_DB = join(parentLink, "missing.sqlite");
    expect(() => getRuntimePathConfig()).toThrow("CODEXCLAW_DB must stay outside");
  });

  isolatedTest("rejects dangling token symlinks before token creation", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    const tokenLink = join(stateDir, "dangling.token");
    symlinkSync(join(stateDir, "missing-target"), tokenLink);
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;
    process.env.CODEXCLAW_CODEX_TOKEN_FILE = tokenLink;

    expect(() => getCodexConnectionConfig()).toThrow("symlink token file");
  });

  isolatedTest("tightens token permissions and rejects missing reverse-proxy tokens", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    const token = join(stateDir, "codex.token");
    writeFileSync(token, "secret\n", { mode: 0o644 });
    chmodSync(token, 0o644);
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;
    process.env.CODEXCLAW_CODEX_TOKEN_FILE = token;

    expect(getCodexConnectionConfig().tokenFile).toBe(token);
    expect(statSync(token).mode & 0o077).toBe(0);

    const missing = join(stateDir, "missing.token");
    process.env.CODEXCLAW_DEPLOYMENT_MODE = "reverse_proxy_wss";
    process.env.CODEXCLAW_CODEX_WS = "wss://codex.example/ws";
    process.env.CODEXCLAW_CODEX_TOKEN_FILE = missing;
    expect(() => getCodexConnectionConfig()).toThrow("must exist in reverse_proxy_wss");
  });

  isolatedTest("tightens database permissions when the sqlite file already exists", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    const db = join(stateDir, "codexclaw.sqlite");
    writeFileSync(db, "", { mode: 0o644 });
    chmodSync(db, 0o644);
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;
    process.env.CODEXCLAW_DB = db;

    expect(getRuntimePathConfig().dbPath).toBe(db);
    expect(statSync(db).mode & 0o077).toBe(0);
  });

  isolatedTest("validates Codex WebSocket deployment policy", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = stateDir;

    process.env.CODEXCLAW_CODEX_WS = "ws://user@example.com:4500";
    expect(() => getCodexConnectionConfig()).toThrow("must not include credentials");

    process.env.CODEXCLAW_CODEX_WS = "wss://codex.example/ws#token";
    expect(() => getCodexConnectionConfig()).toThrow("fragments");

    process.env.CODEXCLAW_CODEX_WS = "ws://example.com:4500";
    expect(() => getCodexConnectionConfig()).toThrow("loopback");

    process.env.CODEXCLAW_CODEX_WS = "ws://127.0.0.1:4500";
    expect(getCodexConnectionConfig().wsUrl).toBe("ws://127.0.0.1:4500");

    process.env.CODEXCLAW_DEPLOYMENT_MODE = "reverse_proxy_wss";
    process.env.CODEXCLAW_CODEX_WS = "ws://127.0.0.1:4500";
    expect(() => getCodexConnectionConfig()).toThrow("wss:// in reverse_proxy_wss");

    process.env.CODEXCLAW_CODEX_WS = "wss://codex.example/ws";
    expect(getCodexConnectionConfig().wsUrl).toBe("wss://codex.example/ws");
  });
});

describe("Telegram config", () => {
  isolatedTest("requires a bot token and allowlisted numeric user ids", () => {
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

    process.env.CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS = "";
    process.env.CODEXCLAW_TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV = "true";
    expect(() => getTelegramConfig()).toThrow("CODEXCLAW_DEPLOYMENT_MODE=local_dev");

    process.env.CODEXCLAW_DEPLOYMENT_MODE = "local_dev";
    expect(getTelegramConfig().allowAllUsersForLocalDev).toBe(true);
  });

  isolatedTest("redacts bot tokens in Telegram API errors", () => {
    expect(redactTelegramSecrets("https://api.telegram.org/bot123:secret/sendMessage failed", "123:secret")).toBe(
      "https://api.telegram.org/bot[telegram-bot-token]/sendMessage failed"
    );
    expect(redactTelegramSecrets("token 123:secret leaked", "123:secret")).toBe("token [telegram-bot-token] leaked");
  });
});

describe("Discord config", () => {
  isolatedTest("requires bot token, application id, public key, and allowed users", () => {
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

    process.env.CODEXCLAW_DISCORD_ALLOWED_USER_IDS = "";
    process.env.CODEXCLAW_DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV = "true";
    expect(() => getDiscordConfig()).toThrow("CODEXCLAW_DEPLOYMENT_MODE=local_dev");

    process.env.CODEXCLAW_DEPLOYMENT_MODE = "local_dev";
    expect(getDiscordConfig().allowAllUsersForLocalDev).toBe(true);
  });

  isolatedTest("redacts Discord bot tokens in API errors", () => {
    expect(redactDiscordSecrets("Authorization failed for Bot secret-token", "secret-token")).toBe(
      "Authorization failed for Bot [discord-bot-token]"
    );
    expect(redactDiscordSecrets("token secret-token leaked", "secret-token")).toBe("token [discord-bot-token] leaked");
  });

  isolatedTest("validates Discord Gateway URL before sending bot tokens", () => {
    process.env.CODEXCLAW_DISCORD_BOT_TOKEN = "secret-token";
    process.env.CODEXCLAW_DISCORD_APPLICATION_ID = "123";
    process.env.CODEXCLAW_DISCORD_PUBLIC_KEY = "a".repeat(64);
    process.env.CODEXCLAW_DISCORD_ALLOWED_USER_IDS = "42";

    process.env.CODEXCLAW_DISCORD_GATEWAY_URL = "ws://example.com/gateway";
    expect(() => getDiscordConfig()).toThrow("CODEXCLAW_DISCORD_GATEWAY_URL must use wss://");

    process.env.CODEXCLAW_DISCORD_GATEWAY_URL = "wss://user@example.com/gateway";
    expect(() => getDiscordConfig()).toThrow("must not include credentials");

    process.env.CODEXCLAW_DISCORD_GATEWAY_URL = "wss://example.com/gateway#token";
    expect(() => getDiscordConfig()).toThrow("fragments");

    process.env.CODEXCLAW_DISCORD_GATEWAY_URL = "ws://127.0.0.1:9000/gateway";
    expect(getDiscordConfig().gatewayUrl).toBe("ws://127.0.0.1:9000/gateway");
  });
});

describe("Wiki config", () => {
  isolatedTest("loads optional wiki settings with bounded limits", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
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

  isolatedTest("rejects out-of-range wiki limits", () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-workspace-")));
    process.env.CODEXCLAW_WORKSPACE_ROOT = workspace;
    process.env.CODEXCLAW_STATE_DIR = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-state-")));
    process.env.CODEXCLAW_WIKI_MAX_QUERY_RESULTS = "100";
    expect(() => getWikiConfig()).toThrow("CODEXCLAW_WIKI_MAX_QUERY_RESULTS");
  });
});
