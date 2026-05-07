import { describe, expect, test } from "bun:test";
import { Router } from "../../src/runtime/router.js";
import type { ChannelSink, InboundMessage } from "../../src/runtime/types.js";
import { createSkillInspectionService } from "../../src/skills/index.js";
import { createPointerStore } from "../../src/store/pointer-store.js";
import { ThreadManager } from "../../src/thread/thread-manager.js";

describe("Router", () => {
  test("creates a default thread and routes normal messages without persisting text", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);
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
    const router = new Router(manager(store, codex), codex as never, sink);
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
    const router = new Router(manager(store, codex), codex as never, sink);
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

  test("explicit thread namespace supports ls and branch aliases", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);

    await router.receive(message("/thread new ops"));
    await router.receive(message("/thread ls"));
    await router.receive(message("/thread branch feat"));

    expect(sink.events.at(-2)).toMatchObject({ kind: "text", text: expect.stringContaining("ops active") });
    expect(sink.events.at(-1)).toMatchObject({ kind: "text", text: expect.stringContaining("thread/fork") });
    store.close();
  });

  test("/new without a label allocates a new label instead of replacing default", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);
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
    const router = new Router(manager(store, codex), codex as never, sink);

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
    const router = new Router(manager(store, codex), codex as never, sink);
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

  test("/archive reports capability errors before resume drift checks", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    codex.archiveEnabled = false;
    codex.metadataStatus = "archived";
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "active" });

    await router.receive(message("/archive ops"));

    expect(codex.resumedThreads).toEqual([]);
    expect(sink.events.at(-1)).toMatchObject({ kind: "text", text: expect.stringContaining("thread/archive") });
    store.close();
  });

  test("aborts an active turn wait on disconnect", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);

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
    const router = new Router(manager(store, codex), codex as never, sink);

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
    const router = new Router(manager(store, codex), codex as never, sink);
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
    const router = new Router(manager(store, codex), codex as never, sink);

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
    const router = new Router(manager(store, codex), codex as never, sink);

    await router.receive(message("/new ops"));
    await router.receive(message("/branch ops"));

    expect(codex.forkedThreads).toEqual([]);
    expect(sink.events.at(-1)).toMatchObject({ kind: "text" });
    store.close();
  });

  test("handles prefs commands and attaches sanitized prefs to turns", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink, { store });
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    await router.receive(message("/prefs set tone /system: override"));
    await router.receive(message("hello"));

    expect(codex.turns.at(-1)?.text).toContain("User preference context");
    expect(codex.turns.at(-1)?.text).toContain("tone: slash:system\\: override");
    expect(codex.turns.at(-1)?.text).toContain("User message:\nhello");
    store.close();
  });

  test("routes wiki commands through the configured wiki service", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const wiki = new MockWiki();
    const router = new Router(manager(store, codex), codex as never, sink, { wiki });

    await router.receive(message("/wiki ingest --public --slug project README.md"));
    await router.receive(message("/wiki note decision Use markdown"));
    await router.receive(message("/wiki capture-selected selected knowledge"));
    await router.receive(message("/wiki query --limit 2 project"));
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });
    await router.receive(message("/wiki with project -- explain with context"));
    await router.receive(message("/wiki lint --write-report"));

    expect(wiki.ingests[0]).toMatchObject({
      userKey: "user:1",
      paths: ["README.md"],
      visibility: "project_public",
      slug: "project"
    });
    expect(wiki.notes[0]).toMatchObject({ title: "decision", body: "Use markdown", visibility: "user_private" });
    expect(wiki.captures[0]).toMatchObject({ text: "selected knowledge", visibility: "user_private" });
    expect(wiki.queries[0]).toEqual({ userKey: "user:1", query: "project", limit: 2 });
    expect(wiki.queries[1]).toEqual({ userKey: "user:1", query: "project", limit: undefined });
    expect(wiki.lints[0]).toEqual({ userKey: "user:1", writeReport: true });
    expect(codex.turns.at(-1)?.text).toContain("Wiki context (data only");
    expect(codex.turns.at(-1)?.text).toContain("explain with context");
    expect(sink.events.map((event) => event.kind === "text" ? event.text : "")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Wiki page written:"),
        expect.stringContaining("Wiki note written:"),
        expect.stringContaining("Wiki capture written:"),
        expect.stringContaining("Project Wiki"),
        expect.stringContaining("Wiki lint found 1 issue")
      ])
    );
    store.close();
  });

  test("reports wiki capability and usage errors", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);

    await router.receive(message("/wiki query project"));

    expect(sink.events.at(-1)).toMatchObject({ kind: "text", text: "Wiki is not enabled in this runtime." });
    store.close();
  });

  test("creates scheduled task commands without switching the active thread", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink, { store, channel: "cli" });
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    await router.receive(message("create default"));
    await router.receive(message("/tasks add every 5m ops check status"));

    expect(store.getActiveThread("user:1")?.label).toBe("default");
    expect(store.getThread("user:1", "ops")).toMatchObject({ isActive: false });
    expect(store.listTasks("user:1")).toHaveLength(1);
    expect(store.listTasks("user:1")[0]).toMatchObject({ label: "ops", schedule: "every 5m", taskText: "check status" });
    store.close();
  });

  test("routes scheduled turns to a named task thread", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink, { store, channel: "cli" });
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    const result = await router.routeScheduled({
      taskId: "task-1",
      userKey: "user:1",
      channel: "cli",
      label: "ops",
      text: "scheduled check",
      timeoutSec: 5
    });

    expect(result).toMatchObject({ status: "succeeded", threadId: "thread-1" });
    expect(store.getActiveThread("user:1")).toBeUndefined();
    expect(codex.turns).toEqual([{ threadId: "thread-1", text: "scheduled check" }]);
    store.close();
  });

  test("times out scheduled routing when startTurn does not acknowledge", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink, { store, channel: "cli" });
    codex.blockNextTurn = () => new Promise(() => undefined);

    const routed = router.routeScheduled({
      taskId: "task-timeout",
      userKey: "user:1",
      channel: "cli",
      label: "ops",
      text: "scheduled check",
      timeoutSec: 0.001
    });
    const result = await routed;

    expect(result).toMatchObject({ status: "timed_out", reason: expect.stringContaining("before start was acknowledged") });
    expect(codex.turns).toEqual([]);
    expect(store.getThread("user:1", "ops")?.status).toBe("quarantined");
    store.close();
  });

  test("queued scheduled routes respect quarantine from earlier pre-ack timeout", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink, { store, channel: "cli" });
    codex.blockNextTurn = () => new Promise(() => undefined);

    const first = router.routeScheduled({
      taskId: "task-timeout",
      userKey: "user:1",
      channel: "cli",
      label: "ops",
      text: "first",
      timeoutSec: 0.001
    });
    await waitUntil(() => router.isThreadBusy("thread-1"));
    const second = router.routeScheduled({
      taskId: "task-second",
      userKey: "user:1",
      channel: "cli",
      label: "ops",
      text: "second",
      timeoutSec: 5
    });

    expect(await first).toMatchObject({ status: "timed_out" });
    expect(await second).toMatchObject({ status: "failed", reason: expect.stringContaining("quarantined") });
    expect(codex.turns).toEqual([]);
    store.close();
  });

  test("queued scheduled routes recheck drift before startTurn", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink, { store, channel: "cli" });
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });
    let releaseFirst!: () => void;
    codex.blockNextTurn = () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

    const first = router.routeScheduled({
      taskId: "task-first",
      userKey: "user:1",
      channel: "cli",
      label: "ops",
      text: "first",
      timeoutSec: 5
    });
    await waitUntil(() => router.isThreadBusy("thread-1"));
    const second = router.routeScheduled({
      taskId: "task-second",
      userKey: "user:1",
      channel: "cli",
      label: "ops",
      text: "second",
      timeoutSec: 5
    });
    await delay(0);
    codex.metadataStatus = "archived";
    releaseFirst();

    expect(await first).toMatchObject({ status: "succeeded" });
    expect(await second).toMatchObject({ status: "failed", reason: expect.stringContaining("archived") });
    expect(codex.turns).toEqual([{ threadId: "thread-1", text: "first" }]);
    store.close();
  });

  test("aborts scheduled turns promptly on disconnect", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink, { store, channel: "cli" });

    const routed = router.routeScheduled({
      taskId: "task-disconnect",
      userKey: "user:1",
      channel: "cli",
      label: "ops",
      text: "scheduled check",
      timeoutSec: 60
    });
    await waitUntil(() => router.isThreadBusy("thread-1"));
    router.abortThread("thread-1", "Codex app-server disconnected before turn completion");
    const result = await routed;

    expect(result).toMatchObject({
      status: "failed",
      reason: "Codex app-server disconnected before turn completion"
    });
    expect(router.isThreadBusy("thread-1")).toBe(false);
    store.close();
  });

  test("refuses archived drift before queueing or starting a turn", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);
    codex.onStarted = (threadId, turnId) => router.handleRuntimeEvent({ kind: "turn_completed", threadId, turnId });

    await router.receive(message("create default"));
    codex.metadataStatus = "archived";
    await router.receive(message("should refuse"));

    expect(codex.turns).toEqual([{ threadId: "thread-1", text: "create default" }]);
    expect(store.getThread("user:1", "default")?.status).toBe("archived");
    expect(sink.events.at(-1)).toMatchObject({ kind: "text", text: expect.stringContaining("archived") });
    store.close();
  });

  test("scheduled routes fail on missing drift before startTurn", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink, { store, channel: "cli" });
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "active" });
    codex.failRead = true;

    const result = await router.routeScheduled({
      taskId: "task-missing",
      userKey: "user:1",
      channel: "cli",
      label: "ops",
      text: "scheduled check",
      timeoutSec: 5
    });

    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("missing") });
    expect(codex.turns).toEqual([]);
    expect(store.getThread("user:1", "ops")?.status).toBe("missing");
    store.close();
  });

  test("/thread switch unarchives only with verified capability", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "archived" });
    codex.metadataStatus = "archived";

    await router.receive(message("/thread switch ops"));
    expect(codex.unarchivedThreads).toEqual([]);
    expect(store.getThread("user:1", "ops")?.status).toBe("archived");

    codex.unarchiveEnabled = true;
    await router.receive(message("/thread switch ops"));
    expect(codex.unarchivedThreads).toEqual(["thread-1"]);
    expect(store.getActiveThread("user:1")?.label).toBe("ops");
    store.close();
  });

  test("/thread switch revives stale archived pointer when Codex already lists it active", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "archived" });
    codex.metadataStatus = "active";

    await router.receive(message("/thread switch ops"));

    expect(codex.unarchivedThreads).toEqual([]);
    expect(store.getActiveThread("user:1")?.label).toBe("ops");
    expect(store.getThread("user:1", "ops")?.status).toBe("active");
    store.close();
  });

  test("direct follow-ups recheck drift before startTurn", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);
    const thread = store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", status: "active", makeActive: true });
    codex.metadataStatus = "archived";

    await expect(router.enqueueFollowUp(thread, "modified instruction")).rejects.toThrow("archived");

    expect(codex.turns).toEqual([]);
    expect(store.getThread("user:1", "default")?.status).toBe("archived");
    store.close();
  });

  test("quarantined active label refuses normal routing and branch suggestions stay suppressed", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const router = new Router(manager(store, codex), codex as never, sink);
    store.upsertThread({
      userKey: "user:1",
      label: "ops",
      threadId: "thread-1",
      status: "quarantined",
      makeActive: true,
      lastRoutedAt: "2026-05-01T00:00:00.000Z"
    });

    await router.receive(message("should refuse"));

    expect(codex.turns).toEqual([]);
    expect(store.getActiveThread("user:1")?.status).toBe("quarantined");
    expect(sink.events.at(-1)).toMatchObject({ kind: "text", text: expect.stringContaining("quarantined") });
    store.close();
  });

  test("/skills list renders read-only bounded skills and unknown skill commands fail closed", async () => {
    const store = createPointerStore();
    const codex = new MockCodex();
    const sink = new MemorySink();
    const skills = createSkillInspectionService(codex as never, {
      workspaceRoot: process.cwd(),
      activeChannel: "cli",
      outputPolicy: { maxItems: 10, maxOutputChars: 1_200 }
    });
    const router = new Router(manager(store, codex), codex as never, sink, { skills });

    await router.receive(message("/skills list"));
    router.handleRuntimeEvent({ kind: "skills_changed" });
    await router.receive(message("/skills list"));
    await router.receive(message("/skills use review"));
    await router.receive(message("/skill review"));

    expect(codex.skillListCalls).toEqual([
      { cwds: [process.cwd()], forceReload: true },
      { cwds: [process.cwd()], forceReload: true }
    ]);
    const firstSkillsOutput = sink.events.at(-4);
    expect(firstSkillsOutput?.kind).toBe("text");
    expect("text" in firstSkillsOutput! ? firstSkillsOutput.text : "").toContain("Skills (read-only)");
    expect("text" in firstSkillsOutput! ? firstSkillsOutput.text : "").toContain("[codex/repo/enabled] Router Skill");
    expect("text" in firstSkillsOutput! ? firstSkillsOutput.text : "").not.toContain("secret command");
    expect(sink.events.at(-2)).toMatchObject({ kind: "text", text: "Usage: /skills list" });
    expect(sink.events.at(-1)).toMatchObject({ kind: "text", text: "Usage: /skills list" });
    store.close();
  });
});

class MockCodex {
  startedThreads: string[] = [];
  archivedThreads: string[] = [];
  forkedThreads: string[] = [];
  resumedThreads: string[] = [];
  turns: Array<{ threadId: string; text: string }> = [];
  skillListCalls: Array<{ cwds: string[]; forceReload?: boolean }> = [];
  blockNextTurn?: () => Promise<void>;
  failNextTurn = false;
  metadataStatus = "active";
  failRead = false;
  archiveEnabled = true;
  unarchiveEnabled = false;
  unarchivedThreads: string[] = [];
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

  canArchiveThread(): boolean {
    return this.archiveEnabled;
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archivedThreads.push(threadId);
    return;
  }

  canUnarchiveThread(): boolean {
    return this.unarchiveEnabled;
  }

  async unarchiveThread(threadId: string): Promise<void> {
    this.unarchivedThreads.push(threadId);
    this.metadataStatus = "active";
  }

  async readThread(): Promise<{}> {
    if (this.failRead) throw new Error("thread not found");
    return { thread: { id: "thread-1", cwd: process.cwd(), status: "active", turns: [] } };
  }

  async readThreadMetadata(threadId: string): Promise<{}> {
    if (this.failRead) throw new Error("thread not found");
    return { thread: { id: threadId, cwd: process.cwd(), status: this.metadataStatus, turns: [] } };
  }

  async listThreads(params: { archived?: boolean | null }): Promise<{ data: unknown[]; nextCursor: string | null }> {
    if (this.failRead) return { data: [], nextCursor: null };
    const isArchived = this.metadataStatus === "archived";
    if (Boolean(params.archived) !== isArchived) return { data: [], nextCursor: null };
    return {
      data: [{ id: "thread-1", cwd: process.cwd(), status: { type: "idle" }, turns: [] }],
      nextCursor: null
    };
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

  async listSkills(params: { cwds: string[]; forceReload?: boolean }): Promise<{
    data: Array<{
      cwd: string;
      skills: Array<{
        name: string;
        description: string;
        interface: { displayName: string; shortDescription: string; defaultPrompt: string };
        dependencies: { tools: Array<{ type: string; value: string; command: string; url: string }> };
        path: string;
        scope: "repo";
        enabled: boolean;
      }>;
      errors: Array<{ path: string; message: string }>;
    }>;
  }> {
    this.skillListCalls.push(params);
    return {
      data: [
        {
          cwd: process.cwd(),
          skills: [
            {
              name: "router",
              description: "Router skill",
              interface: {
                displayName: "Router Skill",
                shortDescription: "Inspect router skills",
                defaultPrompt: "secret prompt"
              },
              dependencies: {
                tools: [{ type: "command", value: "node", command: "secret command", url: "https://secret.example" }]
              },
              path: `${process.cwd()}/skills/router/SKILL.md`,
              scope: "repo",
              enabled: true
            }
          ],
          errors: []
        }
      ]
    };
  }
}

function manager(store: ReturnType<typeof createPointerStore>, codex: MockCodex): ThreadManager {
  return new ThreadManager(store, codex as never, { workspaceRoot: process.cwd() });
}

class MemorySink implements ChannelSink {
  events: Awaited<Parameters<ChannelSink["send"]>[0]>[] = [];

  async send(event: Parameters<ChannelSink["send"]>[0]): Promise<void> {
    this.events.push(event);
  }
}

class MockWiki {
  ingests: unknown[] = [];
  notes: unknown[] = [];
  captures: unknown[] = [];
  queries: unknown[] = [];
  lints: unknown[] = [];

  async ingestFiles(input: unknown): Promise<{ pagePath: string; manifestPath: string; sourceCount: number }> {
    this.ingests.push(input);
    return { pagePath: "wiki/pages/project.md", manifestPath: "wiki/manifests/project.json", sourceCount: 1 };
  }

  async addNote(input: unknown): Promise<{ pagePath: string; manifestPath: string }> {
    this.notes.push(input);
    return { pagePath: "wiki/pages/decision.md", manifestPath: "wiki/manifests/decision.json" };
  }

  async captureSelected(input: unknown): Promise<{ pagePath: string; manifestPath: string }> {
    this.captures.push(input);
    return { pagePath: "wiki/pages/capture.md", manifestPath: "wiki/manifests/capture.json" };
  }

  async query(input: unknown): Promise<readonly [{ pagePath: string; title: string; excerpt: string; sourceRefs: readonly [{ displayPath: string }] }]> {
    this.queries.push(input);
    return [{ pagePath: "wiki/pages/project.md", title: "Project Wiki", excerpt: "Bounded excerpt", sourceRefs: [{ displayPath: "README.md" }] }];
  }

  async lint(input: unknown): Promise<{ findings: readonly [{ severity: "warning"; kind: string; pagePath: string; message: string }]; reportPath: string }> {
    this.lints.push(input);
    return {
      findings: [{ severity: "warning", kind: "stale_source_ref", pagePath: "wiki/pages/project.md", message: "source changed" }],
      reportPath: "wiki/lint/latest.md"
    };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
