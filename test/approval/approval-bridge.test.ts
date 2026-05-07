import { describe, expect, test } from "bun:test";
import { ApprovalBridge } from "../../src/approval/approval-bridge.js";
import type { ChannelAdapter, ChannelApprovalRequest, ChannelApprovalResponse, OutboundMessage } from "../../src/channel/types.js";
import type { RuntimeLogger } from "../../src/runtime/log.js";
import type { Router } from "../../src/runtime/router.js";
import { createPointerStore } from "../../src/store/pointer-store.js";

describe("ApprovalBridge", () => {
  test("approves observed approval requests and clears pending mapping", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    await bridge.handleRuntimeEvent({
      kind: "approval_requested",
      requestId: 7,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", itemId: "item-1", reason: "needs approval" }
    });
    const approvalId = channel.requests[0]?.approvalId;
    expect(approvalId).toBeDefined();
    expect(store.getPendingApproval(`prompt:${approvalId!}`)).toBeDefined();

    await bridge.handleChannelResponse(response(approvalId!, "approve", undefined, `prompt:${approvalId!}`));

    expect(codex.responses).toEqual([{ method: "item/commandExecution/requestApproval", requestId: 7, accepted: true }]);
    expect(store.getPendingApproval(`prompt:${approvalId!}`)).toBeUndefined();
    store.close();
  });

  test("modify rejects original request and queues a follow-up turn", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    await bridge.handleRuntimeEvent({
      kind: "approval_requested",
      requestId: "abc",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", itemId: "item-1", grantRoot: "/tmp/project" }
    });
    const approvalId = channel.requests[0]?.approvalId;
    expect(approvalId).toBeDefined();
    await bridge.handleChannelResponse(response(approvalId!, "modify", "write a smaller file", `prompt:${approvalId!}`));

    expect(codex.responses).toEqual([{ method: "item/fileChange/requestApproval", requestId: "abc", accepted: false }]);
    expect(router.followUps).toHaveLength(1);
    expect(router.followUps[0]?.text).toContain("write a smaller file");
    store.close();
  });

  test("modify follow-up failure still promotes queued approvals", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    router.failFollowUp = true;
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    await bridge.handleRuntimeEvent(approvalEvent(2, "thread-1"));
    const firstApprovalId = channel.requests[0]!.approvalId;
    await bridge.handleChannelResponse(response(firstApprovalId, "modify", "try another way", `prompt:${firstApprovalId}`));

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false }
    ]);
    expect(channel.messages.at(-1)?.text).toContain("not routable");
    expect(channel.requests).toHaveLength(2);
    store.close();
  });

  test("modify follow-up completion does not block queued approval promotion", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    router.blockFollowUp = true;
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    await bridge.handleRuntimeEvent(approvalEvent(2, "thread-1"));
    const firstApprovalId = channel.requests[0]!.approvalId;
    await bridge.handleChannelResponse(response(firstApprovalId, "modify", "try another way", `prompt:${firstApprovalId}`));

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false }
    ]);
    expect(channel.requests).toHaveLength(2);
    store.close();
  });

  test("promoted approval prompt failure rejects it and continues approval processing", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    await bridge.handleRuntimeEvent(approvalEvent(2, "thread-1"));
    await bridge.handleRuntimeEvent(approvalEvent(3, "thread-1"));
    channel.failNextApprovalPrompt = true;
    const firstApprovalId = channel.requests[0]!.approvalId;
    await bridge.handleChannelResponse(response(firstApprovalId, "reject", undefined, `prompt:${firstApprovalId}`));

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false },
      { method: "item/commandExecution/requestApproval", requestId: 2, accepted: false }
    ]);
    expect(channel.requests).toHaveLength(2);
    const thirdApprovalId = channel.requests[1]!.approvalId;
    await bridge.handleChannelResponse(response(thirdApprovalId, "approve", undefined, `prompt:${thirdApprovalId}`));
    expect(codex.responses.at(-1)).toEqual({
      method: "item/commandExecution/requestApproval",
      requestId: 3,
      accepted: true
    });
    store.close();
  });

  test("initial approval prompt failure drains already queued approvals", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    let releasePrompt!: () => void;
    channel.blockNextApprovalPrompt = () =>
      new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    const first = bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    await delay(0);
    await bridge.handleRuntimeEvent(approvalEvent(2, "thread-1"));
    channel.failNextApprovalPrompt = true;
    releasePrompt();
    await first;

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false }
    ]);
    expect(channel.requests).toHaveLength(1);
    const secondApprovalId = channel.requests[0]!.approvalId;
    await bridge.handleChannelResponse(response(secondApprovalId, "approve", undefined, `prompt:${secondApprovalId}`));
    expect(codex.responses.at(-1)).toEqual({
      method: "item/commandExecution/requestApproval",
      requestId: 2,
      accepted: true
    });
    store.close();
  });

  test("modify follow-up notification failure still promotes queued approvals", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    channel.failSend = true;
    const router = new MockRouter();
    router.failFollowUp = true;
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    await bridge.handleRuntimeEvent(approvalEvent(2, "thread-1"));
    const firstApprovalId = channel.requests[0]!.approvalId;
    await bridge.handleChannelResponse(response(firstApprovalId, "modify", "try another way", `prompt:${firstApprovalId}`));

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false }
    ]);
    expect(channel.requests).toHaveLength(2);
    store.close();
  });

  test("binds approval prompts to the last channel thread target", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger, undefined, undefined, {
      getThreadTarget: () => ({ userKey: "user:1", channelThreadKey: "telegram:chat-a" })
    });

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    const approvalId = channel.requests[0]!.approvalId;
    expect(channel.requests[0]!.channelThreadKey).toBe("telegram:chat-a");

    await bridge.handleChannelResponse(
      response(approvalId, "approve", undefined, `prompt:${approvalId}`, "telegram:chat-b")
    );

    expect(codex.responses).toEqual([]);
    expect(store.getPendingApproval(`prompt:${approvalId}`)).toBeDefined();
    store.close();
  });

  test("modify reply can arrive after original approval ttl but before modify ttl", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    let now = new Date("2026-05-01T00:00:00.000Z");
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger, 5 * 60 * 1000, () => now, {
      modifyTtlMs: 10 * 60 * 1000,
      getThreadTarget: () => ({ userKey: "user:1", channelThreadKey: "telegram:chat-a" })
    });

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    const approvalId = channel.requests[0]!.approvalId;
    now = new Date("2026-05-01T00:01:00.000Z");
    await bridge.handleChannelResponse(response(approvalId, "modify", undefined, `prompt:${approvalId}`, "telegram:chat-a"));
    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false }
    ]);

    now = new Date("2026-05-01T00:06:00.000Z");
    await bridge.handleModifyReply({
      approvalId,
      userKey: "user:1",
      channelThreadKey: "telegram:chat-a",
      modifyText: "use a safer command"
    });

    expect(router.followUps).toHaveLength(1);
    expect(router.followUps[0]?.text).toContain("use a safer command");
    store.close();
  });

  test("approval expiry racing modify selection resolves once without follow-up", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    let now = new Date("2026-05-01T00:00:00.000Z");
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger, 1000, () => now);

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    const approvalId = channel.requests[0]!.approvalId;
    now = new Date("2026-05-01T00:00:02.000Z");
    bridge.expirePending(now.toISOString());
    await bridge.handleChannelResponse(response(approvalId, "modify", undefined, `prompt:${approvalId}`));

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false }
    ]);
    expect(router.followUps).toEqual([]);
    store.close();
  });

  test("prompts only one active approval per thread and promotes the next", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    await bridge.handleRuntimeEvent(approvalEvent(2, "thread-1"));

    expect(channel.requests).toHaveLength(1);
    const firstApprovalId = channel.requests[0]!.approvalId;
    await bridge.handleChannelResponse(response(firstApprovalId, "reject", undefined, `prompt:${firstApprovalId}`));

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false }
    ]);
    expect(channel.requests).toHaveLength(2);
    const secondApprovalId = channel.requests[1]!.approvalId;
    await bridge.handleChannelResponse(response(secondApprovalId, "approve", undefined, `prompt:${secondApprovalId}`));

    expect(codex.responses.at(-1)).toEqual({
      method: "item/commandExecution/requestApproval",
      requestId: 2,
      accepted: true
    });
    store.close();
  });

  test("queues same-thread approvals while the first prompt send is in flight", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    let releasePrompt!: () => void;
    channel.blockNextApprovalPrompt = () =>
      new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    const first = bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    await delay(0);
    await bridge.handleRuntimeEvent(approvalEvent(2, "thread-1"));
    expect(channel.requests).toHaveLength(0);

    releasePrompt();
    await first;
    expect(channel.requests).toHaveLength(1);
    const firstApprovalId = channel.requests[0]!.approvalId;
    await bridge.handleChannelResponse(response(firstApprovalId, "reject", undefined, `prompt:${firstApprovalId}`));

    expect(channel.requests).toHaveLength(2);
    store.close();
  });

  test("expires active approval using bridge clock", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    let now = new Date("2026-05-01T00:00:00.000Z");
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger, 1000, () => now);

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    const approvalId = channel.requests[0]!.approvalId;
    now = new Date("2026-05-01T00:00:02.000Z");
    await bridge.handleChannelResponse(response(approvalId, "approve", undefined, `prompt:${approvalId}`));

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false }
    ]);
    expect(channel.messages.at(-1)?.text).toContain("expired");
    await bridge.handleChannelResponse(response(approvalId, "approve", undefined, `prompt:${approvalId}`));
    expect(channel.messages.at(-1)?.text).toContain("no longer pending");
    store.close();
  });

  test("invalidates active and queued approvals on disconnect", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    await bridge.handleRuntimeEvent(approvalEvent(2, "thread-1"));
    const activeApprovalId = channel.requests[0]!.approvalId;

    bridge.invalidateAll("disconnect");

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false },
      { method: "item/commandExecution/requestApproval", requestId: 2, accepted: false }
    ]);
    expect(store.getPendingApproval(`prompt:${activeApprovalId}`)).toBeUndefined();
    expect(channel.messages.at(-1)?.text).toContain("invalidated");
    await bridge.handleChannelResponse(response(activeApprovalId, "approve", undefined, `prompt:${activeApprovalId}`));
    expect(codex.responses).toHaveLength(2);
    store.close();
  });

  test("notifies pending modify waits when invalidated on disconnect", async () => {
    const store = createPointerStore();
    store.upsertThread({ userKey: "user:1", label: "default", threadId: "thread-1", makeActive: true });
    const codex = new MockApprovalCodex();
    const channel = new MockChannel();
    const router = new MockRouter();
    const bridge = new ApprovalBridge(store, codex as never, channel, router as never, noopLogger);

    await bridge.handleRuntimeEvent(approvalEvent(1, "thread-1"));
    const approvalId = channel.requests[0]!.approvalId;
    await bridge.handleChannelResponse(response(approvalId, "modify", undefined, `prompt:${approvalId}`));

    bridge.invalidateAll("disconnect");

    expect(codex.responses).toEqual([
      { method: "item/commandExecution/requestApproval", requestId: 1, accepted: false }
    ]);
    expect(channel.messages.at(-1)?.text).toContain("invalidated: disconnect");
    expect(channel.messages.at(-1)?.attachments).toEqual([{ kind: "status", status: "invalidated" }]);
    await bridge.handleModifyReply({
      approvalId,
      userKey: "user:1",
      modifyText: "late modification"
    });
    expect(router.followUps).toEqual([]);
    store.close();
  });
});

class MockApprovalCodex {
  responses: Array<{ method: string; requestId: number | string; accepted: boolean }> = [];

  sendApprovalResponse(method: string, requestId: number | string, accepted: boolean): void {
    this.responses.push({ method, requestId, accepted });
  }
}

class MockChannel implements ChannelAdapter {
  readonly name = "cli" as const;
  readonly receive = empty<never>();
  readonly approvalResponses = empty<ChannelApprovalResponse>();
  requests: ChannelApprovalRequest[] = [];
  messages: OutboundMessage[] = [];
  failSend = false;
  failNextApprovalPrompt = false;
  blockNextApprovalPrompt?: () => Promise<void>;

  async send(_message: OutboundMessage): Promise<{}> {
    if (this.failSend) throw new Error("send failed");
    this.messages.push(_message);
    return {};
  }

  async requestApproval(request: ChannelApprovalRequest): Promise<{ approvalId: string; channelMessageId: string }> {
    const block = this.blockNextApprovalPrompt;
    this.blockNextApprovalPrompt = undefined;
    if (block) await block();
    if (this.failNextApprovalPrompt) {
      this.failNextApprovalPrompt = false;
      throw new Error("request approval failed");
    }
    this.requests.push(request);
    return { approvalId: request.approvalId, channelMessageId: `prompt:${request.approvalId}` };
  }
}

class MockRouter {
  followUps: Array<{ threadId: string; text: string }> = [];
  failFollowUp = false;
  blockFollowUp = false;

  async enqueueFollowUp(thread: { threadId: string }, text: string): Promise<void> {
    if (this.failFollowUp) throw new Error("thread not routable");
    if (this.blockFollowUp) return new Promise(() => undefined);
    this.followUps.push({ threadId: thread.threadId, text });
  }
}

const noopLogger: RuntimeLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

function response(
  approvalId: string,
  decision: ChannelApprovalResponse["decision"],
  modifyText?: string,
  channelMessageId = approvalId,
  channelThreadKey?: string
): ChannelApprovalResponse {
  return {
    approvalId,
    channelMessageId,
    userKey: "user:1",
    decision,
    modifyText,
    receivedAt: "2026-05-01T00:00:00.000Z",
    channelThreadKey
  };
}

async function* empty<T>(): AsyncIterable<T> {}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function approvalEvent(requestId: number, threadId: string) {
  return {
    kind: "approval_requested" as const,
    requestId,
    method: "item/commandExecution/requestApproval",
    params: { threadId, turnId: "turn-1", itemId: `item-${requestId}`, command: `echo ${requestId}` }
  };
}
