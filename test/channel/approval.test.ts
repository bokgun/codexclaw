import { describe, expect, test } from "bun:test";
import { routeApprovalDecision } from "../../src/channel/approval.js";
import type { ChannelApprovalResponse } from "../../src/channel/types.js";

describe("routeApprovalDecision", () => {
  test("maps approve and reject to observed Codex approval decisions", () => {
    expect(routeApprovalDecision(response("approve"))).toEqual({ codexDecision: "accept" });
    expect(routeApprovalDecision(response("reject"))).toEqual({ codexDecision: "decline" });
  });

  test("maps modify to reject plus follow-up text", () => {
    expect(routeApprovalDecision(response("modify", "use a safer command"))).toEqual({
      codexDecision: "decline",
      followUpText: "use a safer command"
    });
  });
});

function response(decision: ChannelApprovalResponse["decision"], modifyText?: string): ChannelApprovalResponse {
  return {
    approvalId: "approval-1",
    channelMessageId: "message-1",
    userKey: "cli:alice",
    decision,
    modifyText,
    receivedAt: "2026-05-01T00:00:00.000Z"
  };
}
