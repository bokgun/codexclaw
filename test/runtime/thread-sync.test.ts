import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPointerStore } from "../../src/store/pointer-store.js";
import { assertThreadRoutable, syncThreadPointers } from "../../src/runtime/thread-sync.js";

describe("thread sync", () => {
  test("syncs active and archived pointers from bounded metadata-only lists", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "active", threadId: "thread-active", status: "missing", makeActive: true });
    store.upsertThread({ userKey: "user:1", label: "archived", threadId: "thread-archived", status: "active" });
    store.upsertThread({ userKey: "user:1", label: "gone", threadId: "thread-gone", status: "active" });
    store.upsertThread({ userKey: "user:1", label: "held", threadId: "thread-held", status: "quarantined" });
    const codex = new MockCodex(workspaceRoot);
    codex.activePages = [[thread("thread-active", workspaceRoot, "active")]];
    codex.archivedPages = [[thread("thread-archived", workspaceRoot, "archived")]];
    codex.notFound.add("thread-gone");

    const result = await syncThreadPointers(store, codex as never, { workspaceRoot, pageLimit: 2 });

    expect(result).toMatchObject({
      checkedPointers: 4,
      markedActive: 1,
      markedArchived: 1,
      markedMissing: 1,
      preservedQuarantined: 1
    });
    expect(store.getThread("user:1", "active")?.status).toBe("active");
    expect(store.getThread("user:1", "archived")?.status).toBe("archived");
    expect(store.getThread("user:1", "gone")?.status).toBe("missing");
    expect(store.getThread("user:1", "held")?.status).toBe("quarantined");
    expect(codex.reads).toEqual(["thread-gone"]);
    expect(codex.listParams).toEqual([
      expect.objectContaining({ archived: false, cwd: workspaceRoot }),
      expect.objectContaining({ archived: true, cwd: workspaceRoot })
    ]);
    store.close();
  });

  test("uses the list archived filter when generated thread status is an object", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-archived", status: "active", makeActive: true });
    const codex = new MockCodex(workspaceRoot);
    codex.archivedPages = [[thread("thread-archived", workspaceRoot, { type: "idle" })]];

    await syncThreadPointers(store, codex as never, { workspaceRoot, pageLimit: 2 });

    expect(store.getThread("user:1", "ops")?.status).toBe("archived");
    store.close();
  });

  test("preserves pointer state when active and archived list filters overlap", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "active", makeActive: true });
    const codex = new MockCodex(workspaceRoot);
    codex.activePages = [[thread("thread-1", workspaceRoot, { type: "idle" })]];
    codex.archivedPages = [[thread("thread-1", workspaceRoot, { type: "idle" })]];

    const result = await syncThreadPointers(store, codex as never, { workspaceRoot, pageLimit: 2 });

    expect(result.markedActive).toBe(0);
    expect(result.markedArchived).toBe(0);
    expect(result.warnings).toContain("thread_list_ambiguous:thread-1");
    expect(store.getThread("user:1", "ops")?.status).toBe("active");
    store.close();
  });

  test("does not mark missing after a partial page-limited scan", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "unknown", threadId: "thread-unknown", status: "active", makeActive: true });
    const codex = new MockCodex(workspaceRoot);
    codex.activePages = [[thread("thread-other", workspaceRoot, "active")], [thread("thread-more", workspaceRoot, "active")]];

    const result = await syncThreadPointers(store, codex as never, { workspaceRoot, pageLimit: 1 });

    expect(result.warnings).toContain("thread_list_page_limit:active");
    expect(store.getThread("user:1", "unknown")?.status).toBe("active");
    expect(codex.reads).toEqual([]);
    store.close();
  });

  test("does not revive absent pointers as active from thread/read alone", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "missing", makeActive: true });
    const codex = new MockCodex(workspaceRoot);

    const result = await syncThreadPointers(store, codex as never, { workspaceRoot, pageLimit: 2 });

    expect(result.markedActive).toBe(0);
    expect(store.getThread("user:1", "ops")?.status).toBe("missing");
    expect(result.warnings).toContain("thread_sync_unknown:thread-1");
    store.close();
  });

  test("logs read-only sync unknowns below warning level", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "missing", makeActive: true });
    const codex = new MockCodex(workspaceRoot);
    const logger = new MemoryLogger();

    const result = await syncThreadPointers(store, codex as never, { workspaceRoot, pageLimit: 2, logger });

    expect(result.warnings).toContain("thread_sync_unknown:thread-1");
    expect(logger.debugs).toEqual([{ event: "thread_sync_warning", fields: { warning: "thread_sync_unknown:thread-1" } }]);
    expect(logger.warns).toEqual([]);
    store.close();
  });

  test("quarantines cwd mismatches instead of marking them missing", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-other-")));
    const store = createPointerStore();
    const pointer = store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "active", makeActive: true });
    const codex = new MockCodex(otherRoot);

    await expect(assertThreadRoutable(store, codex as never, pointer, workspaceRoot)).rejects.toThrow("quarantined");

    expect(store.getThread("user:1", "ops")?.status).toBe("quarantined");
    store.close();
  });

  test("routes read-verified active threads when complete lists omit them", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    const pointer = store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "active", makeActive: true });
    const codex = new MockCodex(workspaceRoot);

    await expect(assertThreadRoutable(store, codex as never, pointer, workspaceRoot)).resolves.toBeUndefined();

    expect(store.getThread("user:1", "ops")?.status).toBe("active");
    expect(codex.reads).toEqual(["thread-1"]);
    expect(codex.listParams).toEqual([
      expect.objectContaining({ archived: false, cwd: workspaceRoot }),
      expect.objectContaining({ archived: true, cwd: workspaceRoot })
    ]);
    store.close();
  });

  test("uses clearer wording when active route verification is unknown", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    const pointer = store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "active", makeActive: true });
    const codex = new MockCodex(workspaceRoot);
    codex.activePages = [
      [thread("thread-other", workspaceRoot, { type: "idle" })],
      [thread("thread-more-1", workspaceRoot, { type: "idle" })],
      [thread("thread-more-2", workspaceRoot, { type: "idle" })],
      [thread("thread-more-3", workspaceRoot, { type: "idle" })],
      [thread("thread-more-4", workspaceRoot, { type: "idle" })],
      [thread("thread-more-5", workspaceRoot, { type: "idle" })]
    ];

    await expect(assertThreadRoutable(store, codex as never, pointer, workspaceRoot)).rejects.toThrow("locally active");

    expect(store.getThread("user:1", "ops")?.status).toBe("active");
    store.close();
  });

  test("active list membership fails closed before partial archived scans", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    const pointer = store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "active", makeActive: true });
    const codex = new MockCodex(workspaceRoot);
    codex.activePages = [[thread("thread-1", workspaceRoot, { type: "idle" })]];
    codex.archivedPages = [
      [thread("archived-1", workspaceRoot, { type: "idle" })],
      [thread("archived-2", workspaceRoot, { type: "idle" })],
      [thread("archived-3", workspaceRoot, { type: "idle" })],
      [thread("archived-4", workspaceRoot, { type: "idle" })],
      [thread("archived-5", workspaceRoot, { type: "idle" })],
      [thread("archived-6", workspaceRoot, { type: "idle" })]
    ];

    await expect(assertThreadRoutable(store, codex as never, pointer, workspaceRoot)).rejects.toThrow("Thread 'ops'");

    expect(store.getThread("user:1", "ops")?.status).toBe("active");
    store.close();
  });

  test("ambiguous route-time list membership is not routable", async () => {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-sync-")));
    const store = createPointerStore();
    const pointer = store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", status: "active", makeActive: true });
    const codex = new MockCodex(workspaceRoot);
    codex.activePages = [[thread("thread-1", workspaceRoot, { type: "idle" })]];
    codex.archivedPages = [[thread("thread-1", workspaceRoot, { type: "idle" })]];

    await expect(assertThreadRoutable(store, codex as never, pointer, workspaceRoot)).rejects.toThrow("Thread 'ops'");

    expect(store.getThread("user:1", "ops")?.status).toBe("active");
    store.close();
  });
});

class MockCodex {
  activePages: unknown[][] = [[]];
  archivedPages: unknown[][] = [[]];
  reads: string[] = [];
  listParams: unknown[] = [];
  notFound = new Set<string>();

  constructor(private readonly workspaceRoot: string) {}

  async listThreads(params: { archived?: boolean | null; cursor?: string | null }): Promise<{ data: unknown[]; nextCursor: string | null }> {
    this.listParams.push(params);
    const pages = params.archived ? this.archivedPages : this.activePages;
    const index = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    return {
      data: pages[index] ?? [],
      nextCursor: index + 1 < pages.length ? String(index + 1) : null
    };
  }

  async readThreadMetadata(threadId: string): Promise<unknown> {
    this.reads.push(threadId);
    if (this.notFound.has(threadId)) throw new Error("thread not found");
    return { thread: thread(threadId, this.workspaceRoot, "active") };
  }
}

class MemoryLogger {
  debugs: Array<{ event: string; fields?: unknown }> = [];
  infos: Array<{ event: string; fields?: unknown }> = [];
  warns: Array<{ event: string; fields?: unknown }> = [];
  errors: Array<{ event: string; fields?: unknown }> = [];

  debug(event: string, fields?: unknown): void {
    this.debugs.push({ event, fields });
  }

  info(event: string, fields?: unknown): void {
    this.infos.push({ event, fields });
  }

  warn(event: string, fields?: unknown): void {
    this.warns.push({ event, fields });
  }

  error(event: string, fields?: unknown): void {
    this.errors.push({ event, fields });
  }
}

function thread(id: string, cwd: string, status: unknown): unknown {
  return { id, cwd, status, preview: "omitted", turns: [] };
}
