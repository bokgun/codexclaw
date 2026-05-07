import { stderr } from "node:process";
import type { Writable } from "node:stream";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogScalar = string | number | boolean | null | undefined;
export type LogFieldValue = LogScalar | readonly LogFieldValue[] | { readonly [key: string]: LogFieldValue };
export type LogFields = Record<string, LogFieldValue>;

export interface RuntimeLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface JsonLineLoggerOptions {
  stream?: Writable;
  clock?: () => Date;
  minLevel?: LogLevel;
}

export interface LogConfig {
  minLevel: LogLevel;
  format: "json";
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const SECRET_KEY_PATTERN = /(token|secret|password|authorization|credential|cookie|api[_-]?key|signing)/i;
const CONTENT_KEY_PATTERN = /(text|prompt|content|body|diff|patch|command|args|output|transcript|message)$/i;
const MAX_STRING_CHARS = 1_000;
const MAX_OBJECT_KEYS = 32;
const MAX_DEPTH = 4;

export function createJsonLineLogger(options: JsonLineLoggerOptions = {}): RuntimeLogger {
  const stream = options.stream ?? stderr;
  const clock = options.clock ?? (() => new Date());
  const config = getLogConfig();
  const minLevel = process.env.CODEXCLAW_LOG_LEVEL?.trim() ? config.minLevel : options.minLevel ?? config.minLevel;

  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;

    const record = {
      ts: clock().toISOString(),
      level,
      event,
      ...redactLogFields(fields)
    };

    stream.write(`${JSON.stringify(record)}\n`);
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

export function getLogConfig(): LogConfig {
  const format = process.env.CODEXCLAW_LOG_FORMAT?.trim() || process.env.LOG_FORMAT?.trim() || "json";
  if (format !== "json") throw new Error("codexclaw only supports JSON-line logs; set LOG_FORMAT=json or leave it unset");

  const rawLevel = process.env.CODEXCLAW_LOG_LEVEL?.trim();
  return {
    minLevel: rawLevel ? parseLogLevel(rawLevel) : "info",
    format: "json"
  };
}

export function redactLogFields(fields: LogFields): LogFields {
  const redacted: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    redacted[key] = redactLogValue(key, value, 0);
  }

  return redacted;
}

function redactLogValue(key: string, value: LogFieldValue, depth: number): LogFieldValue {
  if (value === undefined) return undefined;
  if (SECRET_KEY_PATTERN.test(key)) return "[redacted]";
  if (CONTENT_KEY_PATTERN.test(key)) return summarizeContent(value);
  if (typeof value === "string") return boundString(redactSecretLikeText(value));

  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length
    };
  }

  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) return { kind: "object", truncated: true };
    const redacted: LogFields = {};
    const entries = Object.entries(value);
    for (const [childKey, childValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
      redacted[childKey] = redactLogValue(childKey, childValue, depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
      redacted._truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return redacted;
  }

  return value;
}

function summarizeContent(value: LogFieldValue): LogFieldValue {
  if (typeof value === "string") return { kind: "content", length: value.length };
  if (Array.isArray(value)) return { kind: "content_array", length: value.length };
  if (value && typeof value === "object") return { kind: "content_object" };
  return "[content omitted]";
}

function boundString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value;
  return `${value.slice(0, MAX_STRING_CHARS)}...[truncated ${value.length - MAX_STRING_CHARS} chars]`;
}

function parseLogLevel(value: string): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new Error("CODEXCLAW_LOG_LEVEL must be one of debug, info, warn, error");
}

function redactSecretLikeText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, "Bot [redacted]")
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, "xox[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g, "gh[redacted]")
    .replace(/\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY)=([^\s]+)/g, (match) => {
      const equals = match.indexOf("=");
      return `${match.slice(0, equals + 1)}[redacted]`;
    })
    .replace(/([?&](?:token|key|secret|password|authorization|cookie)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/([A-Za-z0-9_-]{20,}:[A-Za-z0-9._-]{20,})/g, "[redacted]");
}
