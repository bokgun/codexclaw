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

  async send(_message: OutboundMessage): Promise<{}> {
    this.messages.push(_message);
    return {};
  }

  async requestApproval(request: ChannelApprovalRequest): Promise<{ approvalId: string; channelMessageId: string }> {
    this.requests.push(request);
    return { approvalId: request.approvalId, channelMessageId: `prompt:${request.approvalId}` };
  }
}

class MockRouter {
  followUps: Array<{ threadId: string; text: string }> = [];

  async enqueueFollowUp(thread: { threadId: string }, text: string): Promise<void> {
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
  channelMessageId = approvalId
): ChannelApprovalResponse {
  return {
    approvalId,
    channelMessageId,
    userKey: "user:1",
    decision,
    modifyText,
    receivedAt: "2026-05-01T00:00:00.000Z"
  };
}

async function* empty<T>(): AsyncIterable<T> {}

function approvalEvent(requestId: number, threadId: string) {
  return {
    kind: "approval_requested" as const,
    requestId,
    method: "item/commandExecution/requestApproval",
    params: { threadId, turnId: "turn-1", itemId: `item-${requestId}`, command: `echo ${requestId}` }
  };
}
