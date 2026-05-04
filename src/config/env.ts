import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface CodexConnectionConfig {
  wsUrl: string;
  tokenFile: string;
}

export interface TelegramConfig {
  mode: "polling";
  botToken: string;
  allowedUserIds: readonly string[];
  allowAllUsersForLocalDev: boolean;
  apiBaseUrl: string;
  pollingTimeoutSeconds: number;
  modifyTimeoutMs: number;
  deltaFlushMs: number;
}

export interface DiscordConfig {
  botToken: string;
  applicationId: string;
  publicKey: string;
  allowedUserIds: readonly string[];
  allowAllUsersForLocalDev: boolean;
  allowedGuildIds: readonly string[];
  apiBaseUrl: string;
  interactionsHost: string;
  interactionsPort: number;
  interactionsPath: string;
  gatewayUrl?: string;
  modifyTimeoutMs: number;
  deltaFlushMs: number;
}

export interface SchedulerConfig {
  enabled: boolean;
  tickIntervalMs: number;
  defaultRetry: number;
  defaultTimeoutSec: number;
  failureThreshold: number;
  minScheduleIntervalMs: number;
}

export interface WikiConfig {
  enabled: boolean;
  wikiRoot: string;
  allowedSourceRoots: readonly string[];
  maxSourceBytes: number;
  maxQueryResults: number;
  maxExcerptChars: number;
}

export function loadDotenv(path = ".env"): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = unquoteEnvValue(rawValue);
  }
}

export function getCodexConnectionConfig(): CodexConnectionConfig {
  loadDotenv();

  const wsUrl = process.env.CODEXCLAW_CODEX_WS ?? "ws://127.0.0.1:4500";
  const tokenFile = process.env.CODEXCLAW_CODEX_TOKEN_FILE ?? ".codexclaw/codex.token";
  const resolvedTokenFile = resolve(tokenFile);

  validateWsUrl(wsUrl);
  ensureTokenFile(resolvedTokenFile);

  return {
    wsUrl,
    tokenFile: resolvedTokenFile
  };
}

export function getTelegramConfig(): TelegramConfig {
  loadDotenv();

  const botToken = process.env.CODEXCLAW_TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) throw new Error("CODEXCLAW_TELEGRAM_BOT_TOKEN is required for Telegram polling mode");

  const allowedUserIds = parseCsv(process.env.CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS);
  for (const userId of allowedUserIds) {
    if (!/^\d+$/.test(userId)) throw new Error("CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS must contain numeric Telegram user ids");
  }
  const allowAllUsersForLocalDev = parseBoolean(process.env.CODEXCLAW_TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV);
  if (allowedUserIds.length === 0 && !allowAllUsersForLocalDev) {
    throw new Error(
      "CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS must contain at least one Telegram user id unless CODEXCLAW_TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV=true"
    );
  }

  const apiBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL?.trim() || "https://api.telegram.org";
  validateTelegramApiBaseUrl(apiBaseUrl);

  return {
    mode: "polling",
    botToken,
    allowedUserIds,
    allowAllUsersForLocalDev,
    apiBaseUrl,
    pollingTimeoutSeconds: parseBoundedInteger("CODEXCLAW_TELEGRAM_POLLING_TIMEOUT_SECONDS", 30, 1, 50),
    modifyTimeoutMs: parseBoundedInteger("CODEXCLAW_TELEGRAM_MODIFY_TIMEOUT_MS", 10 * 60 * 1000, 1_000, 30 * 60 * 1000),
    deltaFlushMs: parseBoundedInteger("CODEXCLAW_TELEGRAM_DELTA_FLUSH_MS", 10_000, 0, 30_000)
  };
}

export function getDiscordConfig(): DiscordConfig {
  loadDotenv();

  const botToken = process.env.CODEXCLAW_DISCORD_BOT_TOKEN?.trim();
  if (!botToken) throw new Error("CODEXCLAW_DISCORD_BOT_TOKEN is required for Discord mode");

  const applicationId = process.env.CODEXCLAW_DISCORD_APPLICATION_ID?.trim();
  if (!applicationId || !/^\d+$/.test(applicationId)) {
    throw new Error("CODEXCLAW_DISCORD_APPLICATION_ID is required and must be a Discord snowflake");
  }

  const publicKey = process.env.CODEXCLAW_DISCORD_PUBLIC_KEY?.trim();
  if (!publicKey || !/^[0-9a-fA-F]{64}$/.test(publicKey)) {
    throw new Error("CODEXCLAW_DISCORD_PUBLIC_KEY is required and must be a 32-byte hex Ed25519 public key");
  }

  const allowedUserIds = parseCsv(process.env.CODEXCLAW_DISCORD_ALLOWED_USER_IDS);
  for (const userId of allowedUserIds) {
    if (!/^\d+$/.test(userId)) throw new Error("CODEXCLAW_DISCORD_ALLOWED_USER_IDS must contain Discord snowflakes");
  }
  const allowAllUsersForLocalDev = parseBoolean(process.env.CODEXCLAW_DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV);
  if (allowedUserIds.length === 0 && !allowAllUsersForLocalDev) {
    throw new Error(
      "CODEXCLAW_DISCORD_ALLOWED_USER_IDS must contain at least one Discord user id unless CODEXCLAW_DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV=true"
    );
  }

  const allowedGuildIds = parseCsv(process.env.CODEXCLAW_DISCORD_ALLOWED_GUILD_IDS);
  for (const guildId of allowedGuildIds) {
    if (!/^\d+$/.test(guildId)) throw new Error("CODEXCLAW_DISCORD_ALLOWED_GUILD_IDS must contain Discord snowflakes");
  }

  const apiBaseUrl = process.env.CODEXCLAW_DISCORD_API_BASE_URL?.trim() || "https://discord.com/api/v10";
  validateDiscordApiBaseUrl(apiBaseUrl);
  const gatewayUrl = process.env.CODEXCLAW_DISCORD_GATEWAY_URL?.trim() || undefined;
  if (gatewayUrl) validateDiscordGatewayUrl(gatewayUrl);

  return {
    botToken,
    applicationId,
    publicKey,
    allowedUserIds,
    allowAllUsersForLocalDev,
    allowedGuildIds,
    apiBaseUrl,
    interactionsHost: process.env.CODEXCLAW_DISCORD_INTERACTIONS_HOST?.trim() || "127.0.0.1",
    interactionsPort: parseBoundedInteger("CODEXCLAW_DISCORD_INTERACTIONS_PORT", 8787, 1, 65_535),
    interactionsPath: normalizeHttpPath(process.env.CODEXCLAW_DISCORD_INTERACTIONS_PATH?.trim() || "/discord/interactions"),
    gatewayUrl,
    modifyTimeoutMs: parseBoundedInteger("CODEXCLAW_DISCORD_MODIFY_TIMEOUT_MS", 10 * 60 * 1000, 1_000, 30 * 60 * 1000),
    deltaFlushMs: parseBoundedInteger("CODEXCLAW_DISCORD_DELTA_FLUSH_MS", 750, 0, 30_000)
  };
}

export function getSchedulerConfig(): SchedulerConfig {
  loadDotenv();

  return {
    enabled: parseBoolean(process.env.CODEXCLAW_SCHEDULER_ENABLED),
    tickIntervalMs: parseBoundedInteger("CODEXCLAW_SCHEDULER_TICK_MS", 30_000, 1_000, 3_600_000),
    defaultRetry: parseBoundedInteger("CODEXCLAW_SCHEDULER_DEFAULT_RETRY", 0, 0, 10),
    defaultTimeoutSec: parseBoundedInteger("CODEXCLAW_SCHEDULER_DEFAULT_TIMEOUT_SEC", 300, 1, 86_400),
    failureThreshold: parseBoundedInteger("CODEXCLAW_SCHEDULER_FAILURE_THRESHOLD", 5, 1, 50),
    minScheduleIntervalMs: parseBoundedInteger("CODEXCLAW_SCHEDULER_MIN_INTERVAL_MS", 60_000, 1_000, 86_400_000)
  };
}

export function getWikiConfig(): WikiConfig {
  loadDotenv();

  return {
    enabled: parseBoolean(process.env.CODEXCLAW_WIKI_ENABLED),
    wikiRoot: process.env.CODEXCLAW_WIKI_ROOT?.trim() || "wiki",
    allowedSourceRoots: parseCsv(process.env.CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS ?? "."),
    maxSourceBytes: parseBoundedInteger("CODEXCLAW_WIKI_MAX_SOURCE_BYTES", 128 * 1024, 1, 2 * 1024 * 1024),
    maxQueryResults: parseBoundedInteger("CODEXCLAW_WIKI_MAX_QUERY_RESULTS", 5, 1, 20),
    maxExcerptChars: parseBoundedInteger("CODEXCLAW_WIKI_MAX_EXCERPT_CHARS", 500, 80, 5_000)
  };
}

export function redactTelegramSecrets(value: string, botToken = process.env.CODEXCLAW_TELEGRAM_BOT_TOKEN): string {
  let redacted = value;
  if (botToken) redacted = redacted.split(botToken).join("[telegram-bot-token]");
  return redacted.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot[telegram-bot-token]");
}

export function redactDiscordSecrets(value: string, botToken = process.env.CODEXCLAW_DISCORD_BOT_TOKEN): string {
  let redacted = value;
  if (botToken) redacted = redacted.split(botToken).join("[discord-bot-token]");
  return redacted.replace(/Bot\s+[A-Za-z0-9._-]+/g, "Bot [discord-bot-token]");
}

function ensureTokenFile(tokenFile: string): void {
  if (existsSync(tokenFile)) {
    validateTokenFile(tokenFile);
    return;
  }

  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  validateTokenFile(tokenFile);
}

function validateTokenFile(tokenFile: string): void {
  const link = lstatSync(tokenFile);
  if (link.isSymbolicLink()) throw new Error(`Refusing to use symlink token file: ${tokenFile}`);

  const stat = statSync(tokenFile);
  if (!stat.isFile()) throw new Error(`Token path is not a regular file: ${tokenFile}`);
  if (stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) {
    chmodSync(tokenFile, stat.mode & 0o700);
  }

  const updated = statSync(tokenFile);
  if ((updated.mode & 0o077) !== 0) {
    throw new Error(`Token file must not be group/world accessible: ${tokenFile}`);
  }
}

function validateWsUrl(wsUrl: string): void {
  const url = new URL(wsUrl);
  if (url.username || url.password || url.search) {
    throw new Error("CODEXCLAW_CODEX_WS must not include credentials or query parameters");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`CODEXCLAW_CODEX_WS must use ws:// or wss://, got ${url.protocol}`);
  }
  if (url.protocol === "wss:") return;
  if (isLoopbackHost(url.hostname)) return;
  throw new Error("Refusing plaintext ws:// Codex app-server URL for a non-loopback host; use wss://");
}

function validateTelegramApiBaseUrl(apiBaseUrl: string): void {
  const url = new URL(apiBaseUrl);
  if (url.username || url.password || url.search) {
    throw new Error("CODEXCLAW_TELEGRAM_API_BASE_URL must not include credentials or query parameters");
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error("CODEXCLAW_TELEGRAM_API_BASE_URL must use https:// unless it points at a loopback test server");
}

function validateDiscordApiBaseUrl(apiBaseUrl: string): void {
  const url = new URL(apiBaseUrl);
  if (url.username || url.password || url.search) {
    throw new Error("CODEXCLAW_DISCORD_API_BASE_URL must not include credentials or query parameters");
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error("CODEXCLAW_DISCORD_API_BASE_URL must use https:// unless it points at a loopback test server");
}

function validateDiscordGatewayUrl(gatewayUrl: string): void {
  const url = new URL(gatewayUrl);
  if (url.username || url.password || url.search) {
    throw new Error("CODEXCLAW_DISCORD_GATEWAY_URL must not include credentials or query parameters");
  }
  if (url.protocol === "wss:") return;
  if (url.protocol === "ws:" && isLoopbackHost(url.hostname)) return;
  throw new Error("CODEXCLAW_DISCORD_GATEWAY_URL must use wss:// unless it points at a loopback test server");
}

function normalizeHttpPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseCsv(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function parseBoundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
