import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    expect(methods.slice(6, turnStartIndex)).toEqual(["thread/read", "thread/list", "thread/list"]);
  });

  test("does not block startup routing on slow plugin reconciliation", async () => {
    const env = withRuntimeEnv({
      CODEXCLAW_PLUGIN_SUPERVISION_ENABLED: "true",
      CODEXCLAW_PLUGIN_SUPERVISOR_STARTUP_TIMEOUT_MS: "100"
    });
    const store = createPointerStore();
    const transport = new FakeTransport({ slowMcpReload: true });
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
    expect(methods).toContain("config/mcpServer/reload");
    expect(methods).toContain("turn/start");
    expect(methods.indexOf("turn/start")).toBeGreaterThan(methods.indexOf("config/mcpServer/reload"));
  });

  test("wires plugin commands into startup routing", async () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), "codexclaw-host-plugin-test-"));
    writeFileSync(join(pluginRoot, "codexclaw-plugin.json"), JSON.stringify(validPluginDescriptor(), null, 2));
    const env = withRuntimeEnv({ CODEXCLAW_PLUGIN_DIRS: pluginRoot });
    const store = createPointerStore();
    const transport = new FakeTransport();
    const channel = new SingleMessageChannel({
      id: "msg-1",
      userKey: "user:1",
      channel: "cli",
      text: "/plugin list",
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

    expect(transport.requests.map((request) => request.method)).not.toContain("turn/start");
    expect(channel.sent.at(-1)?.text).toContain("opencandle");
  });

  test("reports plugin reconcile warnings while keeping enablement persisted", async () => {
    const pluginRoot = mkdtempSync(join(tmpdir(), "codexclaw-host-plugin-test-"));
    writeFileSync(join(pluginRoot, "codexclaw-plugin.json"), JSON.stringify(validPluginDescriptor(), null, 2));
    const env = withRuntimeEnv({
      CODEXCLAW_PLUGIN_DIRS: pluginRoot,
      CODEXCLAW_PLUGIN_SUPERVISION_ENABLED: "true",
      OPENCANDLE_ROOT: "/tmp/opencandle"
    });
    const store = createPointerStore();
    const transport = new FakeTransport({ failMcpReloadAfter: 1 });
    const channel = new SingleMessageChannel({
      id: "msg-1",
      userKey: "user:1",
      channel: "cli",
      text: "/plugin enable opencandle --confirm",
      receivedAt: "2026-05-07T00:00:00.000Z"
    }, 10);
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
      expect(store.getPluginEnablement("opencandle")).toMatchObject({ enabled: true, version: "0.1.0" });
      expect(channel.sent.at(-1)?.text).toContain("Enabled plugin 'opencandle'.");
      expect(channel.sent.at(-1)?.text).toContain("Reconcile warning: test mcp reload failure");
      expect(channel.sent.at(-1)?.text).toContain("OPENCANDLE_ROOT=[OPENCANDLE_ROOT]");
      expect(channel.sent.at(-1)?.text).toContain("Bearer [redacted]");
      expect(channel.sent.at(-1)?.text).not.toContain("/tmp/opencandle");
      expect(channel.sent.at(-1)?.text).not.toContain("secret-token");
    } finally {
      runtime.close();
      env.restore();
    }
  });
});

class FakeTransport {
  requests: Array<{ method: string; params?: JsonValue }> = [];
  private threadStarted = false;
  private notificationHandlers = new Set<(event: RpcNotification) => void>();
  private serverRequestHandlers = new Set<(request: RpcServerRequest) => void>();
  private closeHandlers = new Set<(error?: Error) => void>();

  private mcpReloadCount = 0;

  constructor(private readonly options: { slowMcpReload?: boolean; failMcpReloadAfter?: number } = {}) {}

  async request(method: string, params?: JsonValue): Promise<JsonValue> {
    this.requests.push({ method, params });
    if (method === "config/mcpServer/reload") {
      this.mcpReloadCount += 1;
      if (this.options.slowMcpReload) return new Promise(() => {});
      if (this.options.failMcpReloadAfter !== undefined && this.mcpReloadCount > this.options.failMcpReloadAfter) {
        throw new Error("test mcp reload failure OPENCANDLE_ROOT=/tmp/opencandle Bearer secret-token");
      }
      return {};
    }
    if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
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
  readonly sent: OutboundMessage[] = [];

  constructor(
    private readonly inbound: NormalizedMessage,
    private readonly delayMs = 0
  ) {}

  get receive(): AsyncIterable<NormalizedMessage> {
    return single(this.inbound, this.delayMs);
  }

  async send(message: OutboundMessage): Promise<{}> {
    this.sent.push(message);
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

async function* single<T>(value: T, delayMs = 0): AsyncIterable<T> {
  if (delayMs > 0) await delay(delayMs);
  yield value;
}

async function* empty<T>(): AsyncIterable<T> {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withRuntimeEnv(extra: Record<string, string> = {}): { restore(): void } {
  const previous = {
    CODEXCLAW_WORKSPACE_ROOT: process.env.CODEXCLAW_WORKSPACE_ROOT,
    CODEXCLAW_STATE_DIR: process.env.CODEXCLAW_STATE_DIR,
    CODEXCLAW_DEPLOYMENT_MODE: process.env.CODEXCLAW_DEPLOYMENT_MODE,
    CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE: process.env.CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE,
    CODEXCLAW_PLUGIN_SUPERVISION_ENABLED: process.env.CODEXCLAW_PLUGIN_SUPERVISION_ENABLED,
    CODEXCLAW_PLUGIN_DIRS: process.env.CODEXCLAW_PLUGIN_DIRS,
    CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME: process.env.CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME,
    CODEXCLAW_PLUGIN_SUPERVISOR_STARTUP_TIMEOUT_MS: process.env.CODEXCLAW_PLUGIN_SUPERVISOR_STARTUP_TIMEOUT_MS,
    OPENCANDLE_ROOT: process.env.OPENCANDLE_ROOT
  };
  const root = mkdtempSync(join(tmpdir(), "codexclaw-host-test-"));
  process.env.CODEXCLAW_WORKSPACE_ROOT = join(root, "workspace");
  process.env.CODEXCLAW_STATE_DIR = join(root, "state");
  process.env.CODEXCLAW_DEPLOYMENT_MODE = "local_loopback";
  process.env.CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE = "false";
  process.env.CODEXCLAW_PLUGIN_DIRS = "";
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
  return {
    restore() {
      restoreEnv("CODEXCLAW_WORKSPACE_ROOT", previous.CODEXCLAW_WORKSPACE_ROOT);
      restoreEnv("CODEXCLAW_STATE_DIR", previous.CODEXCLAW_STATE_DIR);
      restoreEnv("CODEXCLAW_DEPLOYMENT_MODE", previous.CODEXCLAW_DEPLOYMENT_MODE);
      restoreEnv("CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE", previous.CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE);
      restoreEnv("CODEXCLAW_PLUGIN_SUPERVISION_ENABLED", previous.CODEXCLAW_PLUGIN_SUPERVISION_ENABLED);
      restoreEnv("CODEXCLAW_PLUGIN_DIRS", previous.CODEXCLAW_PLUGIN_DIRS);
      restoreEnv("CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME", previous.CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME);
      restoreEnv("CODEXCLAW_PLUGIN_SUPERVISOR_STARTUP_TIMEOUT_MS", previous.CODEXCLAW_PLUGIN_SUPERVISOR_STARTUP_TIMEOUT_MS);
      restoreEnv("OPENCANDLE_ROOT", previous.OPENCANDLE_ROOT);
    }
  };
}

function validPluginDescriptor(): unknown {
  return {
    schemaVersion: 1,
    id: "opencandle",
    displayName: "OpenCandle",
    version: "0.1.0",
    mcp: {
      serverName: "opencandle",
      command: "/usr/local/bin/bun",
      args: ["server.ts"],
      env: [{ name: "OPENCANDLE_ROOT", required: true }]
    },
    tools: [{ name: "get_fear_greed" }],
    security: {
      network: "declared",
      providers: ["alternative.me"],
      envAllowlist: ["OPENCANDLE_ROOT"]
    }
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
