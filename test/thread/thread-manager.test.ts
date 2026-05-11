import { describe, expect, test } from "bun:test";
import { createPointerStore } from "../../src/store/pointer-store.js";
import { ThreadManager } from "../../src/thread/thread-manager.js";

describe("ThreadManager", () => {
  test("marks active thread missing when resume fails", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", makeActive: true });
    const codex = new MockCodex();
    codex.failResume = true;
    const manager = new ThreadManager(store, codex as never, { workspaceRoot: process.cwd() });

    const resumed = await manager.tryResumeThread(store.getThread("user:1", "ops")!);

    expect(resumed).toBe(false);
    expect(store.getThread("user:1", "ops")?.status).toBe("missing");
    store.close();
  });

  test("marks read-verified active thread missing when rollout resume is absent", async () => {
    const store = createPointerStore();
    const pointer = store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "active", makeActive: true });
    const codex = new MockCodex();
    codex.failResumeOnly = true;
    const manager = new ThreadManager(store, codex as never, { workspaceRoot: process.cwd() });

    await expect(manager.resumeThread(pointer)).rejects.toThrow("create /thread new");

    expect(store.getThread("user:1", "ops")?.status).toBe("missing");
    store.close();
  });

  test("refuses to archive the only active label when default is unavailable", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-default", status: "archived" });
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-ops", status: "active", makeActive: true });
    const codex = new MockCodex();
    const manager = new ThreadManager(store, codex as never, { workspaceRoot: process.cwd() });

    await expect(manager.archiveThread("user:1", "ops")).rejects.toThrow("Cannot archive the only active thread");

    expect(codex.archivedThreads).toEqual([]);
    expect(store.getThread("user:1", "ops")).toMatchObject({ status: "active", isActive: true });
    store.close();
  });

  test("quarantines archived recovery when Codex reports another workspace", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "archived" });
    const codex = new MockCodex();
    codex.workspaceRoot = "/tmp/other-codexclaw-workspace";
    const manager = new ThreadManager(store, codex as never, { workspaceRoot: process.cwd() });

    await expect(manager.switchThread("user:1", "ops")).rejects.toThrow("another workspace");

    expect(store.getThread("user:1", "ops")?.status).toBe("quarantined");
    store.close();
  });
});

class MockCodex {
  failResume = false;
  failResumeOnly = false;
  archiveEnabled = true;
  archivedThreads: string[] = [];
  workspaceRoot = process.cwd();

  async readThread(): Promise<{}> {
    if (this.failResume) throw new Error("missing");
    return { thread: { id: "thread-1", cwd: this.workspaceRoot, status: "active", turns: [] } };
  }

  async readThreadMetadata(threadId: string): Promise<{}> {
    if (this.failResume) throw new Error("missing");
    return { thread: { id: threadId, cwd: this.workspaceRoot, status: "active", turns: [] } };
  }

  async listThreads(params?: { archived?: boolean | null }): Promise<{ data: unknown[]; nextCursor: string | null }> {
    if (this.failResume) return { data: [], nextCursor: null };
    if (params?.archived) return { data: [], nextCursor: null };
    return { data: [{ id: "thread-1", cwd: this.workspaceRoot, status: { type: "idle" }, turns: [] }], nextCursor: null };
  }

  async resumeThread(): Promise<{}> {
    if (this.failResume) throw new Error("missing");
    if (this.failResumeOnly) throw new Error('{"code":-32600,"message":"no rollout found for thread id thread-1"}');
    return {};
  }

  canArchiveThread(): boolean {
    return this.archiveEnabled;
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archivedThreads.push(threadId);
  }
}
