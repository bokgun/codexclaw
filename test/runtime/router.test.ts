import { describe, expect, test } from "bun:test";
import { Router } from "../../src/runtime/router.js";
import type { ChannelSink, InboundMessage } from "../../src/runtime/types.js";
import { createPointerStore } from "../../src/store/pointer-store.js";
import { ThreadManager } from "../../src/thread/thread-manager.js";

describe("Router", () => {
  test("creates a default thread and routes normal messages without persisting text", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    await router.receive(message("hello codex"));

    expect(codex.startedThreads).toEqual(["thread-1"]);
    expect(codex.turns).toEqual([{ threadId: "thread-1", text: "hello codex" }]);
    expect(store.getActiveThread("user:1")).toMatchObject({
      label: "default",
      threadId: "thread-1",
      isActive: true
    });
    expect(store.schemaColumns("threads")).not.toContain("text");
    store.close();
  });

  test("queues same-thread turns deterministically", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    let releaseFirst!: () => void;
    codex.blockNextTurn = () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

    const first = router.receive(message("first"));
    await waitUntil(() => router.isThreadBusy("thread-1"));
    const second = router.receive(message("second"));
    await waitUntil(() => sink.events.some((event) => event.kind === "status"));

    releaseFirst();
    await Promise.all([first, second]);

    expect(codex.turns.map((turn) => turn.text)).toEqual(["first", "second"]);
    expect(sink.events.some((event) => event.kind === "status")).toBe(true);
    store.close();
  });

  test("slash commands switch active labels", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    await router.receive(message("/new ops"));
    await router.receive(message("/new docs"));
    await router.receive(message("/switch ops"));
    await router.receive(message("status"));

    expect(store.getActiveThread("user:1")?.label).toBe("ops");
    expect(codex.turns.at(-1)).toEqual({ threadId: "thread-1", text: "status" });
    expect(codex.resumedThreads).toContain("thread-1");
    store.close();
  });

  test("/new without a label allocates a new label instead of replacing default", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    await router.receive(message("create default"));
    await router.receive(message("/new"));

    expect(store.getThread("user:1", "default")?.threadId).toBe("thread-1");
    expect(store.getActiveThread("user:1")).toMatchObject({ label: "thread-1", threadId: "thread-2" });
    store.close();
  });

  test("rejects duplicate explicit /new labels", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);

    await router.receive(message("/new ops"));
    await router.receive(message("/new ops"));

    expect(codex.startedThreads).toEqual(["thread-1"]);
    expect(sink.events.at(-1)).toMatchObject({ kind: "text" });
    store.close();
  });

  test("does not overwrite the only default pointer when archiving default", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    await router.receive(message("create default"));
    await router.receive(message("/archive default"));

    expect(store.getThread("user:1", "default")).toMatchObject({
      threadId: "thread-1",
      status: "active",
      isActive: true
    });
    expect(codex.archivedThreads).toEqual([]);
    expect(sink.events.at(-1)).toMatchObject({ kind: "text" });
    store.close();
  });

  test("aborts an active turn wait on disconnect", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);

    const routed = router.receive(message("long turn"));
    await waitUntil(() => router.isThreadBusy("thread-1"));
    router.abortThread("thread-1", "disconnect");
    await routed;

    expect(router.isThreadBusy("thread-1")).toBe(false);
    expect(sink.events.at(-1)).toMatchObject({ kind: "text", text: "disconnect" });
    store.close();
  });

  test("can enqueue again after an aborted turn queue is reset", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);

    const first = router.receive(message("will abort"));
    await waitUntil(() => router.isThreadBusy("thread-1"));
    router.abortThread("thread-1", "disconnect");
    await first;

    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });
    await router.receive(message("/switch default"));
    await router.receive(message("after reconnect"));

    expect(codex.turns.map((turn) => turn.text)).toEqual(["will abort", "after reconnect"]);
    store.close();
  });

  test("ordinary turn failure does not prevent already queued work", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);
    codex.failNextTurn = true;
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    await router.receive(message("create default"));
    const first = router.receive(message("will fail"));
    const second = router.receive(message("should run"));
    await Promise.all([first, second]);

    expect(codex.turns.map((turn) => turn.text)).toContain("should run");
    store.close();
  });

  test("/branch fails without creating default when fork capability is disabled", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);

    await router.receive(message("/branch feature"));

    expect(codex.startedThreads).toEqual([]);
    expect(store.listThreads("user:1")).toEqual([]);
    expect(sink.events.at(-1)).toMatchObject({ kind: "text" });
    store.close();
  });

  test("/branch duplicate label is rejected before fork", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(new ThreadManager(store, codex as never), codex as never, sink);

    await router.receive(message("/new ops"));
    await router.receive(message("/branch ops"));

    expect(codex.forkedThreads).toEqual([]);
    expect(sink.events.at(-1)).toMatchObject({ kind: "text" });
    store.close();
  });
});

class MockCodex {
  startedThreads: string[] = [];
  archivedThreads: string[] = [];
  forkedThreads: string[] = [];
  resumedThreads: string[] = [];
  turns: Array<{ threadId: string; text: string }> = [];
  blockNextTurn?: () => Promise<void>;
  failNextTurn = false;
  onStarted?: (threadId: string, turnId: string) => void;

  async startThread(): Promise<string> {
    const id = `thread-${this.startedThreads.length + 1}`;
    this.startedThreads.push(id);
    return id;
  }

  async forkThread(): Promise<string> {
    this.forkedThreads.push("fork");
    return this.startThread();
  }

  canForkThread(): boolean {
    return false;
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archivedThreads.push(threadId);
    return;
  }

  async readThread(): Promise<{}> {
    return {};
  }

  async resumeThread(threadId: string): Promise<{}> {
    this.resumedThreads.push(threadId);
    return {};
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    if (this.failNextTurn) {
      this.failNextTurn = false;
      throw new Error("turn failed");
    }
    const block = this.blockNextTurn;
    this.blockNextTurn = undefined;
    if (block) await block();
    this.turns.push({ threadId, text });
    const turnId = `turn-${this.turns.length}`;
    queueMicrotask(() => this.onStarted?.(threadId, turnId));
    return turnId;
  }
}

class MemorySink implements ChannelSink {
  events: Awaited<Parameters<ChannelSink["send"]>[0]>[] = [];

  async send(event: Parameters<ChannelSink["send"]>[0]): Promise<void> {
    this.events.push(event);
  }
}

function message(text: string): InboundMessage {
  return {
    channel: "cli",
    channelMessageId: `msg:${text}`,
    userKey: "user:1",
    text,
    receivedAt: "2026-05-01T00:00:00.000Z"
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for predicate");
}
