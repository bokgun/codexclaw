import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostRuntime } from "../../src/runtime/host.js";
import type { RuntimeLogger } from "../../src/runtime/log.js";
import type { ChannelAdapter, ChannelApprovalRequest, ChannelApprovalResponse, NormalizedMessage, OutboundMessage } from "../../src/channel/types.js";
import { createPointerStore } from "../../src/store/pointer-store.js";
import type { JsonValue, RpcNotification, RpcServerRequest } from "../../src/codex/ws-client.js";

describe("HostRuntime", () => {
  test("probes and syncs thread metadata before routing startup messages", async () => {
    const env = withRuntimeEnv();
    const store = createPointerStore();
    const transport = new FakeTransport();
    const channel = new SingleMessageChannel({
      id: "msg-1",
      userKey: "user:1",
      channel: "cli",
      text: "hello",
      receivedAt: "2026-05-07T00:00:00.000Z"
    });
    const runtime = new HostRuntime({
      channel,
      store,
      logger: noopLogger,
      scheduler: false,
      wiki: false,
      connectTransport: async () => transport as never
    });

    try {
      await runtime.start();
    } finally {
      runtime.close();
      store.close();
      env.restore();
    }

    const methods = transport.requests.map((request) => request.method);
    const turnStartIndex = methods.indexOf("turn/start");
    expect(turnStartIndex).toBeGreaterThan(-1);
    expect(methods.slice(0, 6)).toEqual([
      "thread/list",
      "thread/list",
      "thread/read",
      "thread/list",
      "thread/list",
      "thread/start"
    ]);
    expect(methods.slice(6, turnStartIndex)).toEqual(["thread/read", "thread/list", "thread/list", "thread/resume"]);
  });
});

class FakeTransport {
  requests: Array<{ method: string; params?: JsonValue }> = [];
  private threadStarted = false;
  private notificationHandlers = new Set<(event: RpcNotification) => void>();
  private serverRequestHandlers = new Set<(request: RpcServerRequest) => void>();
  private closeHandlers = new Set<(error?: Error) => void>();

  async request(method: string, params?: JsonValue): Promise<JsonValue> {
    this.requests.push({ method, params });
    if (method === "thread/list") {
      const archived = Boolean(params && typeof params === "object" && !Array.isArray(params) && params.archived);
      return {
        data: this.threadStarted && !archived ? [{ id: "thread-1", cwd: process.env.CODEXCLAW_WORKSPACE_ROOT!, status: { type: "idle" }, turns: [] }] : [],
        nextCursor: null,
        backwardsCursor: null
      };
    }
    if (method === "thread/read") {
      const threadId = params && typeof params === "object" && !Array.isArray(params) ? params.threadId : undefined;
      if (threadId !== "thread-1") throw new Error("thread not found");
      return { thread: { id: "thread-1", cwd: process.env.CODEXCLAW_WORKSPACE_ROOT!, status: { type: "idle" }, turns: [] } };
    }
    if (method === "thread/start") {
      this.threadStarted = true;
      return { threadId: "thread-1" };
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        for (const handler of this.notificationHandlers) {
          handler({ method: "turn/completed", params: { threadId: "thread-1", turnId: "turn-1" } });
        }
      });
      return { turnId: "turn-1" };
    }
    return {};
  }

  onNotification(handler: (event: RpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: (request: RpcServerRequest) => void): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  respond(): void {}
  respondError(): void {}
  close(): void {}
}

class SingleMessageChannel implements ChannelAdapter {
  readonly name = "cli" as const;
  readonly approvalResponses = empty<ChannelApprovalResponse>();

  constructor(private readonly inbound: NormalizedMessage) {}

  get receive(): AsyncIterable<NormalizedMessage> {
    return single(this.inbound);
  }

  async send(_message: OutboundMessage): Promise<{}> {
    return {};
  }

  async requestApproval(request: ChannelApprovalRequest): Promise<{ approvalId: string; channelMessageId: string }> {
    return { approvalId: request.approvalId, channelMessageId: `prompt:${request.approvalId}` };
  }
}

const noopLogger: RuntimeLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

async function* single<T>(value: T): AsyncIterable<T> {
  yield value;
}

async function* empty<T>(): AsyncIterable<T> {}

function withRuntimeEnv(): { restore(): void } {
  const previous = {
    CODEXCLAW_WORKSPACE_ROOT: process.env.CODEXCLAW_WORKSPACE_ROOT,
    CODEXCLAW_STATE_DIR: process.env.CODEXCLAW_STATE_DIR,
    CODEXCLAW_DEPLOYMENT_MODE: process.env.CODEXCLAW_DEPLOYMENT_MODE,
    CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE: process.env.CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE
  };
  const root = mkdtempSync(join(tmpdir(), "codexclaw-host-test-"));
  process.env.CODEXCLAW_WORKSPACE_ROOT = join(root, "workspace");
  process.env.CODEXCLAW_STATE_DIR = join(root, "state");
  process.env.CODEXCLAW_DEPLOYMENT_MODE = "local_loopback";
  process.env.CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE = "false";
  return {
    restore() {
      restoreEnv("CODEXCLAW_WORKSPACE_ROOT", previous.CODEXCLAW_WORKSPACE_ROOT);
      restoreEnv("CODEXCLAW_STATE_DIR", previous.CODEXCLAW_STATE_DIR);
      restoreEnv("CODEXCLAW_DEPLOYMENT_MODE", previous.CODEXCLAW_DEPLOYMENT_MODE);
      restoreEnv("CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE", previous.CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE);
    }
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
