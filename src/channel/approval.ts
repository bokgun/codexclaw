import type { ChannelApprovalResponse } from "./types.js";

export type CodexApprovalDecision = "accept" | "decline";

export interface RoutedApprovalDecision {
  codexDecision: CodexApprovalDecision;
  followUpText?: string;
}

export function routeApprovalDecision(response: ChannelApprovalResponse): RoutedApprovalDecision {
  if (response.decision === "approve") return { codexDecision: "accept" };
  if (response.decision === "reject") return { codexDecision: "decline" };

  return {
    codexDecision: "decline",
    followUpText: response.modifyText
  };
}
