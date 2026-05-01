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

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const SECRET_KEY_PATTERN = /(token|secret|password|authorization|credential|cookie|api[_-]?key|signing)/i;
const CONTENT_KEY_PATTERN = /(text|prompt|content|body|diff|patch|command|args|output|transcript|message)$/i;

export function createJsonLineLogger(options: JsonLineLoggerOptions = {}): RuntimeLogger {
  const stream = options.stream ?? stderr;
  const clock = options.clock ?? (() => new Date());
  const minLevel = options.minLevel ?? "info";

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

export function redactLogFields(fields: LogFields): LogFields {
  const redacted: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    redacted[key] = redactLogValue(key, value);
  }

  return redacted;
}

function redactLogValue(key: string, value: LogFieldValue): LogFieldValue {
  if (value === undefined) return undefined;
  if (SECRET_KEY_PATTERN.test(key)) return "[redacted]";
  if (CONTENT_KEY_PATTERN.test(key)) return summarizeContent(value);

  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length
    };
  }

  if (value && typeof value === "object") {
    const redacted: LogFields = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      redacted[childKey] = redactLogValue(childKey, childValue);
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
