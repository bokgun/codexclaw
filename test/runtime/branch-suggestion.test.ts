import { describe, expect, test } from "bun:test";
import { BranchSuggestionCoordinator } from "../../src/runtime/branch-suggestion.js";
import type { ChannelSink, InboundMessage, OutboundEvent } from "../../src/runtime/types.js";
import { createPointerStore } from "../../src/store/pointer-store.js";

describe("BranchSuggestionCoordinator", () => {
  test("holds an idle-thread message and routes it after continue", async () => {
    const store = createPointerStore();
    store.upsertThread({
      userKey: "user:1",
      label: "default",
      threadId: "thread-1",
      makeActive: true,
      lastRoutedAt: "2026-05-01T00:00:00.000Z"
    });
    const sink = new MemorySink();
    const coordinator = new BranchSuggestionCoordinator(store, sink, {
      now: () => new Date("2026-05-01T05:00:00.000Z")
    });
    const routed: InboundMessage[] = [];

    const held = await coordinator.maybeHold(message("resume work"));
    expect(held).toBe(true);
    expect(sink.events[0]).toMatchObject({ kind: "branch_suggestion" });
    expect(routed).toEqual([]);

    await coordinator.handleResponse(
      {
        suggestionId: branchEvent(sink).suggestionId,
        userKey: "user:1",
        decision: "continue",
        channelThreadKey: "telegram:chat-1",
        receivedAt: "2026-05-01T05:00:10.000Z"
      },
      async (item) => {
        routed.push(item);
      }
    );

    expect(routed.map((item) => item.text)).toEqual(["resume work"]);
    expect(store.getActiveThread("user:1")?.suppressBranchUntil).toBe("2026-05-08T05:00:00.000Z");
    expect(store.getActiveThread("user:1")?.lastBranchSuggestedAt).toBe("2026-05-01T05:00:00.000Z");
    store.close();
  });

  test("new-thread choice routes /thread new before the held message", async () => {
    const store = createPointerStore();
    store.upsertThread({
      userKey: "user:1",
      label: "default",
      threadId: "thread-1",
      makeActive: true,
      lastRoutedAt: "2026-05-01T00:00:00.000Z"
    });
    const sink = new MemorySink();
    const coordinator = new BranchSuggestionCoordinator(store, sink, {
      now: () => new Date("2026-05-01T05:00:00.000Z")
    });
    const routed: InboundMessage[] = [];

    await coordinator.maybeHold(message("fresh topic"));
    await coordinator.handleResponse(
      {
        suggestionId: branchEvent(sink).suggestionId,
        userKey: "user:1",
        decision: "new_thread",
        channelThreadKey: "telegram:chat-1",
        receivedAt: "2026-05-01T05:00:10.000Z"
      },
      async (item) => {
        routed.push(item);
      }
    );

    expect(routed.map((item) => item.text)).toEqual(["/thread new", "fresh topic"]);
    store.close();
  });

  test("suppresses daily suggestions using thread lifecycle metadata", async () => {
    const store = createPointerStore();
    store.upsertThread({
      userKey: "user:1",
      label: "default",
      threadId: "thread-1",
      makeActive: true,
      lastRoutedAt: "2026-05-01T00:00:00.000Z",
      lastBranchSuggestedAt: "2026-05-01T04:30:00.000Z"
    });
    const sink = new MemorySink();
    const coordinator = new BranchSuggestionCoordinator(store, sink, {
      now: () => new Date("2026-05-01T05:00:00.000Z")
    });

    const held = await coordinator.maybeHold(message("resume work"));

    expect(held).toBe(false);
    expect(sink.events).toEqual([]);
    store.close();
  });

  test("suppresses suggestions for non-active active-label pointers", async () => {
    const store = createPointerStore();
    store.upsertThread({
      userKey: "user:1",
      label: "default",
      threadId: "thread-1",
      status: "quarantined",
      makeActive: true,
      lastRoutedAt: "2026-05-01T00:00:00.000Z"
    });
    const sink = new MemorySink();
    const coordinator = new BranchSuggestionCoordinator(store, sink, {
      now: () => new Date("2026-05-01T05:00:00.000Z")
    });

    const held = await coordinator.maybeHold(message("resume work"));

    expect(held).toBe(false);
    expect(sink.events).toEqual([]);
    store.close();
  });

  test("drops held message bodies when branch suggestion ttl expires", async () => {
    const store = createPointerStore();
    store.upsertThread({
      userKey: "user:1",
      label: "default",
      threadId: "thread-1",
      makeActive: true,
      lastRoutedAt: "2026-05-01T00:00:00.000Z"
    });
    const sink = new MemorySink();
    const coordinator = new BranchSuggestionCoordinator(store, sink, {
      now: () => new Date("2026-05-01T05:00:00.000Z"),
      holdTtlMs: 1
    });

    await coordinator.maybeHold(message("resume work"));
    expect(coordinator.heldCount()).toBe(1);
    await delay(5);

    expect(coordinator.heldCount()).toBe(0);
    store.close();
  });
});

class MemorySink implements ChannelSink {
  events: OutboundEvent[] = [];

  async send(event: OutboundEvent): Promise<void> {
    this.events.push(event);
  }
}

function message(text: string): InboundMessage {
  return {
    channel: "telegram",
    channelMessageId: `telegram:chat-1:${text}`,
    userKey: "user:1",
    text,
    receivedAt: "2026-05-01T05:00:00.000Z",
    channelThreadKey: "telegram:chat-1"
  };
}

function branchEvent(sink: MemorySink): Extract<OutboundEvent, { kind: "branch_suggestion" }> {
  const event = sink.events[0];
  if (event?.kind !== "branch_suggestion") throw new Error("Expected branch suggestion event");
  return event;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
