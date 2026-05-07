import { afterEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createJsonLineLogger, getLogConfig, redactLogFields } from "../../src/runtime/log.js";

const ORIGINAL_ENV = { ...process.env };

function resetLogEnv(): void {
  delete process.env.CODEXCLAW_LOG_LEVEL;
  delete process.env.CODEXCLAW_LOG_FORMAT;
  delete process.env.LOG_FORMAT;
}

function isolatedTest(name: string, fn: () => void | Promise<void>): void {
  test(name, () => {
    resetLogEnv();
    return fn();
  });
}

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("runtime log redaction", () => {
  isolatedTest("redacts secrets and summarizes content fields", () => {
    expect(
      redactLogFields({
        userKey: "cli:alice",
        tokenFile: "/tmp/token",
        prompt: "do not log me",
        nested: {
          command: "rm -rf nope",
          threadId: "thread-1"
        }
      })
    ).toEqual({
      userKey: "cli:alice",
      tokenFile: "[redacted]",
      prompt: { kind: "content", length: 13 },
      nested: {
        command: { kind: "content", length: 11 },
        threadId: "thread-1"
      }
    });
  });

  isolatedTest("redacts secret-looking values in generic string fields", () => {
    expect(
      redactLogFields({
        error:
          "request failed with Authorization: Bearer abc.def_123 and /bot123:secret-token/sendMessage sk-abcdef1234567890XYZ ghp_abcdef1234567890XYZ xoxb-1234567890abcdef CODEXCLAW_TELEGRAM_BOT_TOKEN=12345678901234567890:secret",
        url: "https://example.test/ws?token=secret-value&ok=1"
      })
    ).toEqual({
      error:
        "request failed with Authorization: Bearer [redacted] and /bot[redacted]/sendMessage sk-[redacted] gh[redacted] xox[redacted] CODEXCLAW_TELEGRAM_BOT_TOKEN=[redacted]",
      url: "https://example.test/ws?token=[redacted]&ok=1"
    });
  });

  isolatedTest("writes JSON lines to stderr-compatible streams", () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      }
    });
    const logger = createJsonLineLogger({
      stream,
      clock: () => new Date("2026-05-01T00:00:00.000Z")
    });

    logger.info("routing_decision", {
      userKey: "cli:alice",
      label: "default",
      text: "hidden"
    });

    expect(JSON.parse(output)).toEqual({
      ts: "2026-05-01T00:00:00.000Z",
      level: "info",
      event: "routing_decision",
      userKey: "cli:alice",
      label: "default",
      text: { kind: "content", length: 6 }
    });
  });

  isolatedTest("uses CODEXCLAW_LOG_LEVEL and keeps JSON as the only format", () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      }
    });
    process.env.CODEXCLAW_LOG_LEVEL = "error";
    process.env.LOG_FORMAT = "json";

    const logger = createJsonLineLogger({
      stream,
      clock: () => new Date("2026-05-01T00:00:00.000Z"),
      minLevel: "debug"
    });

    logger.warn("hidden");
    logger.error("visible");

    const lines = output.trim().split(/\n/);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: "error",
      event: "visible"
    });
    expect(getLogConfig()).toEqual({ minLevel: "error", format: "json" });

    process.env.CODEXCLAW_LOG_LEVEL = "trace";
    expect(() => getLogConfig()).toThrow("CODEXCLAW_LOG_LEVEL");

    process.env.CODEXCLAW_LOG_LEVEL = "info";
    process.env.LOG_FORMAT = "pretty";
    expect(() => getLogConfig()).toThrow("JSON-line logs");
  });
});
