import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventDispatcher } from "../../src/runtime/events.js";
import type { ChannelSink, FileDeliveryPolicy, OutboundEvent } from "../../src/runtime/types.js";
import type { RuntimeLogger } from "../../src/runtime/log.js";

describe("EventDispatcher", () => {
  test("suppresses routine Telegram status messages", async () => {
    const sink = new MemorySink();
    const dispatcher = new EventDispatcher(sink, noopLogger);
    dispatcher.bindThread("thread-1", {
      channel: "telegram",
      userKey: "telegram:42",
      channelThreadKey: "telegram:42"
    });

    await dispatcher.dispatch({ kind: "turn_started", threadId: "thread-1", turnId: "turn-1" });
    await dispatcher.dispatch({ kind: "tool_event", threadId: "thread-1", turnId: "turn-1", status: "completed" });
    await dispatcher.dispatch({ kind: "diff_updated", threadId: "thread-1", turnId: "turn-1", size: 123 });
    await dispatcher.dispatch({ kind: "agent_delta", threadId: "thread-1", turnId: "turn-1", delta: "Hello" });
    await dispatcher.dispatch({ kind: "turn_completed", threadId: "thread-1", turnId: "turn-1" });

    expect(sink.events.map((event) => event.kind === "agent_delta" ? event.delta : event.text)).toEqual([
      "Hello",
    ]);
  });

  test("keeps detailed tool status messages for CLI targets", async () => {
    const sink = new MemorySink();
    const dispatcher = new EventDispatcher(sink, noopLogger);
    dispatcher.bindThread("thread-1", { channel: "cli", userKey: "cli:alice" });

    await dispatcher.dispatch({ kind: "tool_event", threadId: "thread-1", turnId: "turn-1", status: "completed" });

    expect(sink.events).toEqual([
      {
        kind: "status",
        channel: "cli",
        userKey: "cli:alice",
        channelThreadKey: undefined,
        text: "Tool event: completed"
      }
    ]);
  });

  test("suppresses routine Discord status messages", async () => {
    const sink = new MemorySink();
    const dispatcher = new EventDispatcher(sink, noopLogger);
    dispatcher.bindThread("thread-1", {
      channel: "discord",
      userKey: "discord:42",
      channelThreadKey: "discord:100"
    });

    await dispatcher.dispatch({ kind: "turn_started", threadId: "thread-1", turnId: "turn-1" });
    await dispatcher.dispatch({ kind: "tool_event", threadId: "thread-1", turnId: "turn-1", status: "completed" });
    await dispatcher.dispatch({ kind: "diff_updated", threadId: "thread-1", turnId: "turn-1", size: 123 });
    await dispatcher.dispatch({ kind: "agent_delta", threadId: "thread-1", turnId: "turn-1", delta: "Hello" });
    await dispatcher.dispatch({ kind: "turn_completed", threadId: "thread-1", turnId: "turn-1" });

    expect(sink.events.map((event) => event.kind === "agent_delta" ? event.delta : event.text)).toEqual(["Hello"]);
    expect(sink.flushCount).toBe(1);
  });

  test("emits metadata-only document delivery for intended Telegram turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-events-"));
    const sink = new MemorySink();
    const dispatcher = new EventDispatcher(sink, noopLogger, { fileDeliveryPolicy: policy(root) });
    dispatcher.bindThread(
      "thread-1",
      {
        channel: "telegram",
        userKey: "telegram:42",
        channelThreadKey: "telegram:42"
      },
      { fileDelivery: { enabled: true, userKey: "telegram:42", channelThreadKey: "telegram:42" } }
    );
    writeFileSync(join(root, "report.pdf"), "pdf");

    await dispatcher.dispatch({ kind: "agent_delta", threadId: "thread-1", turnId: "turn-1", delta: "Saved report." });
    await dispatcher.dispatch({ kind: "file_change", threadId: "thread-1", turnId: "turn-1", paths: ["report.pdf"] });
    await dispatcher.dispatch({ kind: "turn_completed", threadId: "thread-1", turnId: "turn-1" });

    expect(sink.events.at(-1)).toMatchObject({
      kind: "document_delivery",
      channel: "telegram",
      userKey: "telegram:42",
      documents: [{ displayName: "report.pdf", sizeBytes: 3, source: "runtime_file_metadata" }]
    });
    expect(sink.events.at(-1)).not.toHaveProperty("body");
  });

  test("does not emit document delivery without current-turn intent", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-events-"));
    writeFileSync(join(root, "report.pdf"), "pdf");
    const sink = new MemorySink();
    const dispatcher = new EventDispatcher(sink, noopLogger, { fileDeliveryPolicy: policy(root) });
    dispatcher.bindThread(
      "thread-1",
      { channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42" },
      { fileDelivery: { enabled: false, userKey: "telegram:42", channelThreadKey: "telegram:42" } }
    );

    await dispatcher.dispatch({ kind: "agent_delta", threadId: "thread-1", turnId: "turn-1", delta: "Saved report.pdf." });
    await dispatcher.dispatch({ kind: "turn_completed", threadId: "thread-1", turnId: "turn-1" });

    expect(sink.events.map((event) => event.kind)).toEqual(["agent_delta"]);
  });

  test("collects document candidates from runtime file metadata without persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-events-"));
    mkdirSync(join(root, "out"));
    const sink = new MemorySink();
    const dispatcher = new EventDispatcher(sink, noopLogger, { fileDeliveryPolicy: policy(root) });
    dispatcher.bindThread(
      "thread-1",
      { channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42" },
      { fileDelivery: { enabled: true, userKey: "telegram:42", channelThreadKey: "telegram:42" } }
    );
    writeFileSync(join(root, "out/report.pdf"), "pdf");

    await dispatcher.dispatch({ kind: "agent_delta", threadId: "thread-1", turnId: "turn-1", delta: "Saved out/report.pdf." });
    await dispatcher.dispatch({ kind: "file_change", threadId: "thread-1", turnId: "turn-1", paths: ["out/report.pdf"] });
    await dispatcher.dispatch({ kind: "turn_completed", threadId: "thread-1", turnId: "turn-1" });

    expect(sink.events.at(-1)).toMatchObject({
      kind: "document_delivery",
      documents: [{ displayName: "report.pdf" }]
    });
  });

  test("clears intended delivery state when a turn completes without file metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-events-"));
    writeFileSync(join(root, "next.pdf"), "pdf");
    const sink = new MemorySink();
    const dispatcher = new EventDispatcher(sink, noopLogger, { fileDeliveryPolicy: policy(root) });
    dispatcher.bindThread(
      "thread-1",
      { channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42" },
      { fileDelivery: { enabled: true, userKey: "telegram:42", channelThreadKey: "telegram:42" } }
    );

    await dispatcher.dispatch({ kind: "turn_started", threadId: "thread-1", turnId: "turn-1" });
    await dispatcher.dispatch({ kind: "turn_completed", threadId: "thread-1", turnId: "turn-1" });
    dispatcher.bindThread(
      "thread-1",
      { channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42" },
      { fileDelivery: { enabled: false, userKey: "telegram:42", channelThreadKey: "telegram:42" } }
    );
    await dispatcher.dispatch({ kind: "turn_started", threadId: "thread-1", turnId: "turn-2" });
    await dispatcher.dispatch({ kind: "file_change", threadId: "thread-1", turnId: "turn-2", paths: ["next.pdf"] });
    await dispatcher.dispatch({ kind: "turn_completed", threadId: "thread-1", turnId: "turn-2" });

    expect(sink.events.map((event) => event.kind)).toEqual([]);
  });

  test("does not carry file delivery intent across a pre-start failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-events-"));
    writeFileSync(join(root, "next.pdf"), "pdf");
    const sink = new MemorySink();
    const dispatcher = new EventDispatcher(sink, noopLogger, { fileDeliveryPolicy: policy(root) });
    dispatcher.bindThread(
      "thread-1",
      { channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42" },
      { fileDelivery: { enabled: true, userKey: "telegram:42", channelThreadKey: "telegram:42" } }
    );
    dispatcher.bindThread(
      "thread-1",
      { channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42" },
      { fileDelivery: { enabled: false, userKey: "telegram:42", channelThreadKey: "telegram:42" } }
    );

    await dispatcher.dispatch({ kind: "turn_started", threadId: "thread-1", turnId: "turn-2" });
    await dispatcher.dispatch({ kind: "file_change", threadId: "thread-1", turnId: "turn-2", paths: ["next.pdf"] });
    await dispatcher.dispatch({ kind: "turn_completed", threadId: "thread-1", turnId: "turn-2" });

    expect(sink.events.map((event) => event.kind)).toEqual([]);
  });
});

class MemorySink implements ChannelSink {
  readonly events: OutboundEvent[] = [];
  flushCount = 0;

  async send(event: OutboundEvent): Promise<void> {
    this.events.push(event);
  }

  async flushDeltas(): Promise<void> {
    this.flushCount += 1;
  }
}

const noopLogger: RuntimeLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

function policy(root: string): FileDeliveryPolicy {
  return {
    enabled: true,
    allowedRoots: [root],
    deniedRoots: [join(root, ".codexclaw"), join(root, ".codex"), join(root, ".git")],
    deniedSegments: [".git", ".codex", ".codexclaw"],
    maxFileBytes: 1024,
    maxFilesPerTurn: 3,
    maxCandidatesPerTurn: 30,
    workspaceRoot: root
  };
}
