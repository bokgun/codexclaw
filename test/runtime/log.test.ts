import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createJsonLineLogger, redactLogFields } from "../../src/runtime/log.js";

describe("runtime log redaction", () => {
  test("redacts secrets and summarizes content fields", () => {
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

  test("writes JSON lines to stderr-compatible streams", () => {
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
});
