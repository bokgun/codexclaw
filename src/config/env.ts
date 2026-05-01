import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  ensureTokenFile(resolvedTokenFile);

  return {
    wsUrl,
    tokenFile: resolvedTokenFile
  };
}

function ensureTokenFile(tokenFile: string): void {
  if (existsSync(tokenFile)) return;

  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
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
