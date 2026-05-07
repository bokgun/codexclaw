import { describe, expect, test } from "bun:test";
import { CapabilityError } from "../../src/runtime/errors.js";
import { CODEX_METHODS, CodexRuntimeClient } from "../../src/codex/runtime-client.js";

describe("CodexRuntimeClient thread metadata surfaces", () => {
  test("uses metadata-only thread read and bounded list params", async () => {
    const transport = new MockTransport();
    const client = new CodexRuntimeClient(transport as never);

    await client.readThreadMetadata("thread-1");
    await client.listThreads({ archived: true, cwd: "/workspace", cursor: "next", limit: 25, useStateDbOnly: false });

    expect(transport.requests).toEqual([
      { method: CODEX_METHODS.threadRead, params: { threadId: "thread-1", includeTurns: false } },
      {
        method: CODEX_METHODS.threadList,
        params: { archived: true, cwd: "/workspace", cursor: "next", limit: 25, useStateDbOnly: false }
      }
    ]);
  });

  test("gates archive and unarchive behind verified capabilities", async () => {
    const transport = new MockTransport();
    const disabled = new CodexRuntimeClient(transport as never);
    await expect(disabled.archiveThread("thread-1")).rejects.toBeInstanceOf(CapabilityError);
    await expect(disabled.unarchiveThread("thread-1")).rejects.toBeInstanceOf(CapabilityError);

    const enabled = new CodexRuntimeClient(transport as never, {
      capabilities: { archiveThread: true, unarchiveThread: true }
    });
    await enabled.archiveThread("thread-1");
    await enabled.unarchiveThread("thread-1");

    expect(transport.requests.slice(-2)).toEqual([
      { method: CODEX_METHODS.threadArchive, params: { threadId: "thread-1" } },
      { method: CODEX_METHODS.threadUnarchive, params: { threadId: "thread-1" } }
    ]);
  });

  test("probe records list and not-found shape without mutating thread state", async () => {
    const transport = new MockTransport();
    const client = new CodexRuntimeClient(transport as never);

    const result = await client.probeThreadCapabilities("/workspace");

    expect(result).toMatchObject({
      list: true,
      archiveExternallyVerified: false,
      unarchiveExternallyVerified: false,
      notFoundShape: expect.stringContaining("not found")
    });
    expect(client.canArchiveThread()).toBe(false);
    expect(client.canUnarchiveThread()).toBe(false);
    expect(transport.requests.map((request) => request.method)).toEqual([
      CODEX_METHODS.threadList,
      CODEX_METHODS.threadList,
      CODEX_METHODS.threadRead
    ]);
    expect(transport.requests[0].params).toMatchObject({ archived: false, cwd: "/workspace", limit: 1 });
    expect(transport.requests[1].params).toMatchObject({ archived: true, cwd: "/workspace", limit: 1 });
  });
});

class MockTransport {
  requests: Array<{ method: string; params: unknown }> = [];

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === CODEX_METHODS.threadList) return { data: [], nextCursor: null, backwardsCursor: null };
    if (method === CODEX_METHODS.threadStart) return { threadId: "thread-probe" };
    if (method === CODEX_METHODS.threadArchive || method === CODEX_METHODS.threadUnarchive) return {};
    if (method === CODEX_METHODS.threadRead && readThreadId(params).startsWith("codexclaw-missing-")) {
      throw new Error("thread not found");
    }
    if (method === CODEX_METHODS.threadRead) return { thread: { id: "thread-1", cwd: "/workspace", status: "active", turns: [] } };
    return {};
  }

  onNotification(): void {}
  onServerRequest(): void {}
  onClose(): () => void {
    return () => undefined;
  }
  close(): void {}
}

function readThreadId(params: unknown): string {
  return params && typeof params === "object" && "threadId" in params && typeof params.threadId === "string" ? params.threadId : "";
}
