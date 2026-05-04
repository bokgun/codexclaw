import { describe, expect, test } from "bun:test";
import { EventDispatcher } from "../../src/runtime/events.js";
import type { ChannelSink, OutboundEvent } from "../../src/runtime/types.js";
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
