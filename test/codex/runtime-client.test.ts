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

  test("emits metadata-only file change paths for added files", async () => {
    const transport = new MockTransport();
    const client = new CodexRuntimeClient(transport as never);
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));

    transport.emitNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "item-1",
          status: "inProgress",
          changes: [{ path: "started-only.txt", kind: { type: "add" }, diff: "ignored" }]
        }
      }
    });
    transport.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "item-2",
          status: "failed",
          changes: [{ path: "failed.txt", kind: { type: "add" }, diff: "ignored" }]
        }
      }
    });
    transport.emitNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "item-1",
          status: "completed",
          changes: [
            { path: "new-report.txt", kind: { type: "add" }, diff: "raw diff must not be emitted" },
            { path: "existing.txt", kind: { type: "update", move_path: null }, diff: "ignored" }
          ]
        }
      }
    });

    expect(events).toContainEqual({ kind: "file_change", threadId: "thread-1", turnId: "turn-1", paths: ["new-report.txt"] });
    expect(JSON.stringify(events)).not.toContain("started-only.txt");
    expect(JSON.stringify(events)).not.toContain("failed.txt");
    expect(JSON.stringify(events)).not.toContain("raw diff must not be emitted");
  });

  test("wraps MCP reload and status list methods", async () => {
    const transport = new MockTransport();
    const client = new CodexRuntimeClient(transport as never);

    await client.reloadMcpServers();
    const status = await client.listMcpServerStatus({ detail: "toolsAndAuthOnly", limit: 5 });

    expect(status).toEqual({ data: [{ name: "toy", tools: {}, resources: [], resourceTemplates: [], authStatus: null }], nextCursor: null });
    expect(transport.requests.slice(-2)).toEqual([
      { method: CODEX_METHODS.mcpServerReload, params: undefined },
      { method: CODEX_METHODS.mcpServerStatusList, params: { detail: "toolsAndAuthOnly", limit: 5 } }
    ]);
  });

  test("emits MCP startup status as bounded metadata", async () => {
    const transport = new MockTransport();
    const client = new CodexRuntimeClient(transport as never);
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));

    transport.emitNotification({
      method: CODEX_METHODS.mcpServerStartupStatusUpdated,
      params: {
        name: "toy",
        status: "failed",
        error: `${"x".repeat(200)} OPENAI_API_KEY=sk-1234567890abcdefghijkl raw secret that must be truncated`
      }
    });

    expect(events).toEqual([
      {
        kind: "mcp_server_startup_status",
        serverName: "toy",
        startupState: "failed",
        errorSummary: "x".repeat(160)
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("raw secret");
    expect(JSON.stringify(events)).not.toContain("sk-1234567890abcdefghijkl");
  });

  test("declines MCP elicitation requests without emitting raw request content", async () => {
    const transport = new MockTransport();
    const client = new CodexRuntimeClient(transport as never);
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));

    transport.emitServerRequest({
      id: "elicitation-1",
      method: CODEX_METHODS.mcpServerElicitationRequest,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "toy",
        mode: "form",
        message: "raw prompt must not be emitted",
        requestedSchema: { type: "object", properties: { secret: { type: "string", description: "raw schema" } } },
        _meta: { secret: "raw meta" }
      }
    });

    expect(transport.responses).toEqual([
      { id: "elicitation-1", result: { action: "decline", content: null, _meta: null } }
    ]);
    expect(events).toEqual([
      {
        kind: "mcp_server_request_failed_closed",
        method: CODEX_METHODS.mcpServerElicitationRequest
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("raw prompt");
    expect(JSON.stringify(events)).not.toContain("raw schema");
    expect(JSON.stringify(events)).not.toContain("raw meta");
  });

  test("fails closed for unsupported MCP server requests without raw params", async () => {
    const transport = new MockTransport();
    const client = new CodexRuntimeClient(transport as never);
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event));

    transport.emitServerRequest({
      id: 7,
      method: "mcpServer/custom/request",
      params: {
        threadId: "thread-1",
        serverName: "toy",
        payload: "raw payload must not be emitted"
      }
    });

    expect(transport.errors).toEqual([
      { id: 7, error: { code: -32601, message: "Unsupported MCP server request method" } }
    ]);
    expect(events).toEqual([
      {
        kind: "mcp_server_request_failed_closed",
        method: "mcpServer/custom/request"
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("raw payload");
  });
});

class MockTransport {
  requests: Array<{ method: string; params: unknown }> = [];
  responses: Array<{ id: number | string; result: unknown }> = [];
  errors: Array<{ id: number | string; error: unknown }> = [];
  notificationHandlers: Array<(notification: { method: string; params?: unknown }) => void> = [];
  serverRequestHandlers: Array<(request: { id: number | string; method: string; params?: unknown }) => void> = [];

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === CODEX_METHODS.threadList) return { data: [], nextCursor: null, backwardsCursor: null };
    if (method === CODEX_METHODS.threadStart) return { threadId: "thread-probe" };
    if (method === CODEX_METHODS.threadArchive || method === CODEX_METHODS.threadUnarchive) return {};
    if (method === CODEX_METHODS.threadRead && readThreadId(params).startsWith("codexclaw-missing-")) {
      throw new Error("thread not found");
    }
    if (method === CODEX_METHODS.threadRead) return { thread: { id: "thread-1", cwd: "/workspace", status: "active", turns: [] } };
    if (method === CODEX_METHODS.mcpServerStatusList) {
      return { data: [{ name: "toy", tools: {}, resources: [], resourceTemplates: [], authStatus: null }], nextCursor: null };
    }
    return {};
  }

  onNotification(handler: (notification: { method: string; params?: unknown }) => void): void {
    this.notificationHandlers.push(handler);
  }
  onServerRequest(handler: (request: { id: number | string; method: string; params?: unknown }) => void): void {
    this.serverRequestHandlers.push(handler);
  }
  onClose(): () => void {
    return () => undefined;
  }
  close(): void {}
  respond(id: number | string, result: unknown): void {
    this.responses.push({ id, result });
  }
  respondError(id: number | string, error: unknown): void {
    this.errors.push({ id, error });
  }

  emitNotification(notification: { method: string; params?: unknown }): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }

  emitServerRequest(request: { id: number | string; method: string; params?: unknown }): void {
    for (const handler of this.serverRequestHandlers) handler(request);
  }
}

function readThreadId(params: unknown): string {
  return params && typeof params === "object" && "threadId" in params && typeof params.threadId === "string" ? params.threadId : "";
}
