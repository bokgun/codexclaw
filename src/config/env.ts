import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface CodexConnectionConfig {
  wsUrl: string;
  tokenFile: string;
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
