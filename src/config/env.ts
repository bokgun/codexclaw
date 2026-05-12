import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export interface RuntimePathConfig {
  workspaceRoot: string;
  stateDir: string;
  dbPath: string;
  deploymentMode: DeploymentMode;
  allowWorkspaceInternalState: boolean;
}

export interface CodexConnectionConfig {
  wsUrl: string;
  tokenFile: string;
}

export type DeploymentMode = "local_dev" | "local_loopback" | "reverse_proxy_wss";

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

export interface FileDeliveryConfig {
  enabled: boolean;
  allowedRoots: readonly string[];
  deniedRoots: readonly string[];
  deniedSegments: readonly string[];
  maxFileBytes: number;
  maxFilesPerTurn: number;
  maxCandidatesPerTurn: number;
  workspaceRoot: string;
}

export interface ThreadCapabilityConfig {
  forkThread: boolean;
  archiveThread: boolean;
  unarchiveThread: boolean;
}

export interface PluginConfig {
  pluginDirs: readonly string[];
  maxDescriptorBytes: number;
  workspaceRoot: string;
  deniedRoots: readonly string[];
}

export interface PluginSupervisorEnvConfig {
  enabled: boolean;
  managedCodexHome: string;
  managedConfigPath: string;
  startupTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxRestartAttempts: number;
  diagnosticMaxChars: number;
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

  const paths = getRuntimePathConfig();
  const wsUrl = process.env.CODEXCLAW_CODEX_WS?.trim() || "ws://127.0.0.1:4500";
  const tokenFile = process.env.CODEXCLAW_CODEX_TOKEN_FILE?.trim();
  const resolvedTokenFile = tokenFile ? resolveStatePath(paths.stateDir, tokenFile, "codex.token") : resolve(paths.stateDir, "codex.token");

  refuseSymlinkPath(resolvedTokenFile, "token file");
  validateWorkspaceBoundary(resolvedTokenFile, "CODEXCLAW_CODEX_TOKEN_FILE", paths);
  validateStateOwnedPath(resolvedTokenFile, "CODEXCLAW_CODEX_TOKEN_FILE", paths);
  validateWsUrl(wsUrl, paths.deploymentMode);
  ensureTokenFile(resolvedTokenFile, paths.deploymentMode);

  return {
    wsUrl,
    tokenFile: resolvedTokenFile
  };
}

export function getRuntimePathConfig(): RuntimePathConfig {
  loadDotenv();

  const deploymentMode = parseDeploymentMode(process.env.CODEXCLAW_DEPLOYMENT_MODE);
  const allowWorkspaceInternalState = parseBoolean(process.env.CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE);
  const workspaceRoot = resolveWorkspaceRoot(process.env.CODEXCLAW_WORKSPACE_ROOT?.trim() || process.cwd());
  const stateDirInput = process.env.CODEXCLAW_STATE_DIR?.trim();
  const stateDirPath = stateDirInput ? resolveAgainst(workspaceRoot, stateDirInput) : resolveHomePath("~/.codexclaw");
  const policy = {
    workspaceRoot,
    stateDir: stateDirPath,
    deploymentMode,
    allowWorkspaceInternalState
  };
  validateWorkspaceBoundary(stateDirPath, "CODEXCLAW_STATE_DIR", policy);
  const stateDir = ensurePrivateDirectory(stateDirPath, "CODEXCLAW_STATE_DIR");
  validateWorkspaceBoundary(stateDir, "CODEXCLAW_STATE_DIR", policy);
  const dbPathInput = process.env.CODEXCLAW_DB?.trim();
  const dbPath = dbPathInput
    ? resolveStatePath(stateDir, dbPathInput, "codexclaw.sqlite", ["codexclaw.db"])
    : resolve(stateDir, "codexclaw.sqlite");
  validateDatabasePath(dbPath);
  validateWorkspaceBoundary(dbPath, "CODEXCLAW_DB", policy);
  validateStateOwnedPath(dbPath, "CODEXCLAW_DB", { ...policy, stateDir });

  return {
    workspaceRoot,
    stateDir,
    dbPath,
    deploymentMode,
    allowWorkspaceInternalState
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
  validateAllowAllUsersForLocalDev("CODEXCLAW_TELEGRAM_ALLOW_ALL_USERS_FOR_LOCAL_DEV", allowAllUsersForLocalDev);
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
  validateAllowAllUsersForLocalDev("CODEXCLAW_DISCORD_ALLOW_ALL_USERS_FOR_LOCAL_DEV", allowAllUsersForLocalDev);
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

  const paths = getRuntimePathConfig();
  return {
    enabled: parseBoolean(process.env.CODEXCLAW_WIKI_ENABLED),
    wikiRoot: resolveAgainst(paths.workspaceRoot, process.env.CODEXCLAW_WIKI_ROOT?.trim() || "wiki"),
    allowedSourceRoots: parseCsv(process.env.CODEXCLAW_WIKI_ALLOWED_SOURCE_ROOTS ?? ".").map((root) =>
      resolveAgainst(paths.workspaceRoot, root)
    ),
    maxSourceBytes: parseBoundedInteger("CODEXCLAW_WIKI_MAX_SOURCE_BYTES", 128 * 1024, 1, 2 * 1024 * 1024),
    maxQueryResults: parseBoundedInteger("CODEXCLAW_WIKI_MAX_QUERY_RESULTS", 5, 1, 20),
    maxExcerptChars: parseBoundedInteger("CODEXCLAW_WIKI_MAX_EXCERPT_CHARS", 500, 80, 5_000)
  };
}

export function getFileDeliveryConfig(): FileDeliveryConfig {
  loadDotenv();

  const paths = getRuntimePathConfig();
  const enabled = parseBoolean(process.env.CODEXCLAW_TELEGRAM_FILE_DELIVERY_ENABLED);
  const configuredRoots = parseCsv(process.env.CODEXCLAW_FILE_DELIVERY_ALLOWED_ROOTS);
  const allowedRoots = (configuredRoots.length > 0 ? configuredRoots : [paths.workspaceRoot]).map((root) =>
    realpathDirectory(resolveAgainst(paths.workspaceRoot, root), "CODEXCLAW_FILE_DELIVERY_ALLOWED_ROOTS")
  );
  const tokenFile = process.env.CODEXCLAW_CODEX_TOKEN_FILE?.trim()
    ? resolveStatePath(paths.stateDir, process.env.CODEXCLAW_CODEX_TOKEN_FILE.trim(), "codex.token")
    : resolve(paths.stateDir, "codex.token");
  const deniedRoots = [
    paths.stateDir,
    paths.dbPath,
    tokenFile,
    resolveHomePath("~/.codex"),
    resolve(paths.workspaceRoot, ".git"),
    resolve(paths.workspaceRoot, ".codex")
  ].map((path) => normalizePath(resolveExistingPathTarget(path)));
  for (const root of allowedRoots) {
    if (deniedRoots.some((denied) => root === denied || root.startsWith(`${denied}/`))) {
      throw new Error("CODEXCLAW_FILE_DELIVERY_ALLOWED_ROOTS must not include codexclaw state, Codex rollout, token, db, or .git paths");
    }
  }

  return {
    enabled,
    allowedRoots,
    deniedRoots,
    deniedSegments: [".git", ".codex", ".codexclaw"],
    maxFileBytes: parseBoundedInteger("CODEXCLAW_FILE_DELIVERY_MAX_BYTES", 20 * 1024 * 1024, 1, 49 * 1024 * 1024),
    maxFilesPerTurn: parseBoundedInteger("CODEXCLAW_FILE_DELIVERY_MAX_FILES", 3, 1, 10),
    maxCandidatesPerTurn: 30,
    workspaceRoot: paths.workspaceRoot
  };
}

export function getThreadCapabilityConfig(): ThreadCapabilityConfig {
  return {
    forkThread: parseBoolean(process.env.CODEXCLAW_VERIFIED_THREAD_FORK),
    archiveThread: parseBoolean(process.env.CODEXCLAW_VERIFIED_THREAD_ARCHIVE),
    unarchiveThread: parseBoolean(process.env.CODEXCLAW_VERIFIED_THREAD_UNARCHIVE)
  };
}

export function getPluginConfig(): PluginConfig {
  loadDotenv();

  const paths = getRuntimePathConfig();
  const tokenFile = process.env.CODEXCLAW_CODEX_TOKEN_FILE?.trim()
    ? resolveStatePath(paths.stateDir, process.env.CODEXCLAW_CODEX_TOKEN_FILE.trim(), "codex.token")
    : resolve(paths.stateDir, "codex.token");
  const codexHome = process.env.CODEX_HOME?.trim()
    ? resolveHomePath(process.env.CODEX_HOME.trim())
    : resolveHomePath("~/.codex");
  const pluginDirs = parseCsv(process.env.CODEXCLAW_PLUGIN_DIRS).map((dir) => resolveAgainst(paths.workspaceRoot, dir));
  const deniedRoots = [
    paths.stateDir,
    paths.dbPath,
    tokenFile,
    codexHome,
    resolveHomePath("~/.codex"),
    resolve(paths.workspaceRoot, ".git"),
    resolve(paths.workspaceRoot, ".codex"),
    resolve(paths.workspaceRoot, ".codexclaw")
  ].map((path) => normalizePath(resolveExistingPathTarget(path)));

  return {
    pluginDirs,
    maxDescriptorBytes: parseBoundedInteger(
      "CODEXCLAW_PLUGIN_DESCRIPTOR_MAX_BYTES",
      64 * 1024,
      1,
      1024 * 1024
    ),
    workspaceRoot: paths.workspaceRoot,
    deniedRoots
  };
}

export function getPluginSupervisorEnvConfig(): PluginSupervisorEnvConfig {
  loadDotenv();

  const paths = getRuntimePathConfig();
  const enabled = parseBoolean(process.env.CODEXCLAW_PLUGIN_SUPERVISION_ENABLED);
  const managedCodexHome = resolveStatePath(
    paths.stateDir,
    enabled ? process.env.CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME?.trim() || "codex-home" : "codex-home",
    "codex-home"
  );
  if (enabled) {
    validateWorkspaceBoundary(managedCodexHome, "CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME", paths);
    validateStateOwnedPath(managedCodexHome, "CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME", paths);
    refuseSymlinkPath(managedCodexHome, "CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME");
  }
  const managedConfigPath = resolve(managedCodexHome, "config.toml");

  return {
    enabled,
    managedCodexHome,
    managedConfigPath,
    startupTimeoutMs: parseBoundedInteger("CODEXCLAW_PLUGIN_SUPERVISOR_STARTUP_TIMEOUT_MS", 1_500, 100, 30_000),
    backoffBaseMs: parseBoundedInteger("CODEXCLAW_PLUGIN_SUPERVISOR_BACKOFF_BASE_MS", 250, 50, 30_000),
    backoffMaxMs: parseBoundedInteger("CODEXCLAW_PLUGIN_SUPERVISOR_BACKOFF_MAX_MS", 5_000, 100, 300_000),
    maxRestartAttempts: parseBoundedInteger("CODEXCLAW_PLUGIN_SUPERVISOR_MAX_RESTART_ATTEMPTS", 3, 0, 50),
    diagnosticMaxChars: parseBoundedInteger("CODEXCLAW_PLUGIN_SUPERVISOR_DIAGNOSTIC_MAX_CHARS", 240, 40, 2_000)
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

function ensureTokenFile(tokenFile: string, deploymentMode: DeploymentMode): void {
  refuseSymlinkPath(tokenFile, "token file");
  if (existsSync(tokenFile)) {
    validateTokenFile(tokenFile);
    return;
  }

  if (deploymentMode === "reverse_proxy_wss") {
    throw new Error(`CODEXCLAW_CODEX_TOKEN_FILE must exist in reverse_proxy_wss mode: ${tokenFile}`);
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

function validateDatabasePath(dbPath: string): void {
  refuseSymlinkPath(dbPath, "CODEXCLAW_DB");
  if (!existsSync(dbPath)) return;

  const stat = statSync(dbPath);
  if (!stat.isFile()) throw new Error(`CODEXCLAW_DB must be a file when it already exists: ${dbPath}`);
  if (stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) {
    chmodSync(dbPath, stat.mode & 0o700);
  }
  const updated = statSync(dbPath);
  if ((updated.mode & 0o077) !== 0) {
    throw new Error(`CODEXCLAW_DB must not be group/world accessible: ${dbPath}`);
  }
}

function refuseSymlinkPath(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to use symlink ${label}: ${path}`);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

function resolveWorkspaceRoot(input: string): string {
  const resolved = resolveHomePath(input);
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });
  const stat = statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`CODEXCLAW_WORKSPACE_ROOT must be a directory: ${resolved}`);
  return realpathSync(resolved);
}

function resolveAgainst(base: string, input: string): string {
  return resolveHomePath(input, base);
}

function resolveStatePath(stateDir: string, input: string, basename: string, legacyBasenames: readonly string[] = []): string {
  for (const legacyBasename of [basename, ...legacyBasenames]) {
    if (input !== `.codexclaw/${legacyBasename}` && input !== `.codexclaw\\${legacyBasename}`) continue;
    if (legacyBasename !== basename) return resolve(stateDir, basename);
    return resolve(stateDir, legacyBasename);
  }
  return resolveHomePath(input, stateDir);
}

function resolveHomePath(input: string, base = process.cwd()): string {
  const home = process.env.HOME || homedir();
  if (input === "~") return home;
  if (input.startsWith("~/")) return resolve(home, input.slice(2));
  return resolve(base, input);
}

function ensurePrivateDirectory(path: string, name: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error(`Refusing symlink ${name}: ${path}`);
  const stat = statSync(path);
  if (!stat.isDirectory()) throw new Error(`${name} must be a directory: ${path}`);
  if (stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) {
    chmodSync(path, stat.mode & 0o700);
  }
  const updated = statSync(path);
  if ((updated.mode & 0o077) !== 0) {
    throw new Error(`${name} must not be group/world accessible: ${path}`);
  }
  return realpathSync(path);
}

function realpathDirectory(path: string, name: string): string {
  const resolved = realpathSync(path);
  if (!statSync(resolved).isDirectory()) throw new Error(`${name} must contain directories: ${path}`);
  return normalizePath(resolved);
}

function validateWsUrl(wsUrl: string, deploymentMode: DeploymentMode): void {
  const url = new URL(wsUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CODEXCLAW_CODEX_WS must not include credentials, query parameters, or fragments");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`CODEXCLAW_CODEX_WS must use ws:// or wss://, got ${url.protocol}`);
  }
  if (deploymentMode === "reverse_proxy_wss") {
    if (url.protocol !== "wss:") throw new Error("CODEXCLAW_CODEX_WS must use wss:// in reverse_proxy_wss mode");
    return;
  }
  if ((deploymentMode === "local_loopback" || deploymentMode === "local_dev") && !isLoopbackHost(url.hostname)) {
    throw new Error(`CODEXCLAW_CODEX_WS must point at a loopback host in ${deploymentMode} mode`);
  }
  if (url.protocol === "wss:") return;
  if (isLoopbackHost(url.hostname)) return;
  throw new Error("Refusing plaintext ws:// Codex app-server URL for a non-loopback host; use wss://");
}

function parseDeploymentMode(value: string | undefined): DeploymentMode {
  const raw = value?.trim() || "local_loopback";
  if (raw === "local_dev" || raw === "local_loopback" || raw === "reverse_proxy_wss") return raw;
  throw new Error("CODEXCLAW_DEPLOYMENT_MODE must be one of local_dev, local_loopback, reverse_proxy_wss");
}

function validateWorkspaceBoundary(
  path: string,
  name: "CODEXCLAW_STATE_DIR" | "CODEXCLAW_CODEX_TOKEN_FILE" | "CODEXCLAW_DB" | "CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME",
  config: Pick<RuntimePathConfig, "workspaceRoot" | "deploymentMode" | "allowWorkspaceInternalState">
): void {
  const insideWorkspace = isInsideWorkspace(path, config.workspaceRoot);
  if (!insideWorkspace) return;

  if (config.deploymentMode === "local_dev" && config.allowWorkspaceInternalState) return;
  throw new Error(
    `${name} must stay outside CODEXCLAW_WORKSPACE_ROOT unless CODEXCLAW_DEPLOYMENT_MODE=local_dev and CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE=true`
  );
}

function validateStateOwnedPath(
  path: string,
  name: "CODEXCLAW_CODEX_TOKEN_FILE" | "CODEXCLAW_DB" | "CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME",
  config: Pick<RuntimePathConfig, "stateDir" | "deploymentMode" | "allowWorkspaceInternalState">
): void {
  if (isInsideDirectory(path, config.stateDir)) return;
  if (config.deploymentMode === "local_dev" && config.allowWorkspaceInternalState) return;
  throw new Error(
    `${name} must stay inside CODEXCLAW_STATE_DIR unless CODEXCLAW_DEPLOYMENT_MODE=local_dev and CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE=true`
  );
}

function isInsideWorkspace(path: string, workspaceRoot: string): boolean {
  return isInsideDirectory(path, workspaceRoot);
}

function isInsideDirectory(path: string, directory: string): boolean {
  const root = normalizePath(directory);
  const candidate = normalizePath(resolveExistingPathTarget(path));
  return candidate === root || candidate.startsWith(`${root}/`);
}

function resolveExistingPathTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path);

  let current = path;
  const missingSegments: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    missingSegments.unshift(basename(current));
    current = parent;
  }

  return join(realpathSync(current), ...missingSegments);
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function validateTelegramApiBaseUrl(apiBaseUrl: string): void {
  const url = new URL(apiBaseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CODEXCLAW_TELEGRAM_API_BASE_URL must not include credentials, query parameters, or fragments");
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error("CODEXCLAW_TELEGRAM_API_BASE_URL must use https:// unless it points at a loopback test server");
}

function validateDiscordApiBaseUrl(apiBaseUrl: string): void {
  const url = new URL(apiBaseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CODEXCLAW_DISCORD_API_BASE_URL must not include credentials, query parameters, or fragments");
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
  throw new Error("CODEXCLAW_DISCORD_API_BASE_URL must use https:// unless it points at a loopback test server");
}

function validateDiscordGatewayUrl(gatewayUrl: string): void {
  const url = new URL(gatewayUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("CODEXCLAW_DISCORD_GATEWAY_URL must not include credentials, query parameters, or fragments");
  }
  if (url.protocol === "wss:") return;
  if (url.protocol === "ws:" && isLoopbackHost(url.hostname)) return;
  throw new Error("CODEXCLAW_DISCORD_GATEWAY_URL must use wss:// unless it points at a loopback test server");
}

function validateAllowAllUsersForLocalDev(name: string, enabled: boolean): void {
  if (!enabled) return;
  const deploymentMode = parseDeploymentMode(process.env.CODEXCLAW_DEPLOYMENT_MODE);
  if (deploymentMode !== "local_dev") {
    throw new Error(`${name}=true requires CODEXCLAW_DEPLOYMENT_MODE=local_dev`);
  }
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
