import { isAbsolute } from "node:path";
import type { PluginValidationDiagnostic } from "./types.js";

export const MAX_PLUGIN_ID_LENGTH = 64;
export const MAX_PLUGIN_DISPLAY_LENGTH = 120;
export const MAX_PLUGIN_DESCRIPTION_LENGTH = 500;
export const MAX_PLUGIN_PROVIDER_LENGTH = 80;
export const MAX_PLUGIN_TOOL_NAME_LENGTH = 80;
export const MAX_PLUGIN_ARG_LENGTH = 500;
export const MAX_PLUGIN_ARGS = 64;
export const MAX_PLUGIN_ENV_VARS = 32;
export const MAX_PLUGIN_TOOLS = 64;
export const MAX_PLUGIN_DIAGNOSTIC_VALUE_LENGTH = 120;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9._/-]{1,80}$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,79}$/;
const SHELL_METACHAR_PATTERN = /[;&|`$<>()[\]{}*?!~]/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

const SENSITIVE_ENV_EXACT = new Set([
  "CODEX_HOME",
  "CODEX_AUTH",
  "CODEX_AUTH_FILE",
  "CODEX_TOKEN",
  "CODEXCLAW_CODEX_TOKEN_FILE",
  "CODEXCLAW_CODEX_WS_AUTH",
  "CODEXCLAW_STATE_DIR",
  "CODEXCLAW_DB",
  "CODEXCLAW_TELEGRAM_BOT_TOKEN",
  "CODEXCLAW_DISCORD_BOT_TOKEN",
  "CODEXCLAW_DISCORD_PUBLIC_KEY",
  "OPENAI_API_KEY"
]);

const SENSITIVE_ENV_WORD_PATTERN = /(^|_)(AUTH|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|SESSION|COOKIE|BEARER|CREDENTIALS?)($|_)/;
const SENSITIVE_PATH_PATTERN = /(^|_)(DB|DATABASE|STATE_DIR|TOKEN_FILE|AUTH_FILE)($|_)/;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_PATTERN.test(value);
}

export function isValidPluginId(value: string): boolean {
  return value.length <= MAX_PLUGIN_ID_LENGTH && IDENTIFIER_PATTERN.test(value) && !value.includes("..");
}

export function isValidServerName(value: string): boolean {
  return SERVER_NAME_PATTERN.test(value) && !value.includes("..");
}

export function isValidToolName(value: string): boolean {
  return TOOL_NAME_PATTERN.test(value) && !value.includes("..") && !hasControlChars(value);
}

export function isValidEnvName(value: string): boolean {
  return ENV_NAME_PATTERN.test(value);
}

export function isSensitiveEnvName(value: string): boolean {
  return SENSITIVE_ENV_EXACT.has(value) || SENSITIVE_ENV_WORD_PATTERN.test(value) || SENSITIVE_PATH_PATTERN.test(value);
}

export function isValidCommandPath(value: string): boolean {
  return isAbsolute(value) && !hasControlChars(value) && !SHELL_METACHAR_PATTERN.test(value);
}

export function isValidArgValue(value: string): boolean {
  return value.length <= MAX_PLUGIN_ARG_LENGTH && !hasControlChars(value);
}

export function sanitizeDisplayString(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 15))}...[truncated]`;
}

export function diagnostic(
  path: string,
  code: PluginValidationDiagnostic["code"],
  message: string
): PluginValidationDiagnostic {
  return { path, code, message };
}

export function summarizeUntrustedValue(value: unknown): string {
  if (typeof value !== "string") return typeof value;
  const bounded = sanitizeDisplayString(value, MAX_PLUGIN_DIAGNOSTIC_VALUE_LENGTH);
  return JSON.stringify(bounded);
}

export function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: PluginValidationDiagnostic[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      diagnostics.push(diagnostic(`${path}.${key}`, "unknown_field", `Unknown plugin descriptor field '${key}'`));
    }
  }
}
