import { describe, expect, test } from "bun:test";
import { createPointerStore } from "../../src/store/pointer-store.js";
import { ThreadManager } from "../../src/thread/thread-manager.js";

describe("ThreadManager", () => {
  test("marks active thread missing when resume fails", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "ops", threadId: "thread-1", makeActive: true });
    const codex = new MockCodex();
    codex.failResume = true;
    const manager = new ThreadManager(store, codex as never);

    const resumed = await manager.tryResumeThread(store.getThread("user:1", "ops")!);

    expect(resumed).toBe(false);
    expect(store.getThread("user:1", "ops")?.status).toBe("missing");
    store.close();
  });
});

class MockCodex {
  failResume = false;

  async readThread(): Promise<{}> {
    if (this.failResume) throw new Error("missing");
    return {};
  }

  async resumeThread(): Promise<{}> {
    if (this.failResume) throw new Error("missing");
    return {};
  }
}
