export type ChannelMessageId = string;
export type UserKey = string;
export type ThreadId = string;
export type TimestampIso = string;
export type ChannelKind = "cli" | "telegram" | "discord";
export type ApprovalDecision = "approve" | "reject" | "modify";

export interface NormalizedMessage {
  id: ChannelMessageId;
  userKey: UserKey;
  channel: ChannelKind;
  text: string;
  receivedAt: TimestampIso;
  channelThreadKey?: string;
  replyToMessageId?: ChannelMessageId;
}

export type ChannelCommand =
  | { kind: "new"; label?: string }
  | { kind: "threads" }
  | { kind: "switch"; label: string }
  | { kind: "branch"; label?: string }
  | { kind: "archive"; label: string }
  | { kind: "quit" };

export type ParsedChannelInput =
  | { kind: "command"; command: ChannelCommand }
  | { kind: "message"; message: NormalizedMessage };

export interface OutboundMessage {
  kind?: "text" | "agent_delta" | "status";
  channel: ChannelKind;
  userKey: UserKey;
  text: string;
  channelThreadKey?: string;
  replyToMessageId?: ChannelMessageId;
  attachments?: readonly OutboundAttachment[];
}

export type OutboundAttachment =
  | {
      kind: "approval_actions";
      approvalId: string;
      options: readonly ApprovalDecision[];
    }
  | {
      kind: "status";
      status: string;
    }
  | {
      kind: "diff_summary";
      filesChanged?: number;
      additions?: number;
      deletions?: number;
    };

export interface ChannelSendResult {
  channelMessageId?: ChannelMessageId;
}

export interface ChannelApprovalRequest {
  approvalId: string;
  userKey: UserKey;
  threadId: ThreadId;
  prompt: string;
  options: readonly ApprovalDecision[];
  expiresAt: TimestampIso;
  channelThreadKey?: string;
}

export interface ChannelApprovalPrompt {
  approvalId: string;
  channelMessageId: ChannelMessageId;
}

export interface ChannelApprovalResponse {
  approvalId: string;
  channelMessageId: ChannelMessageId;
  userKey: UserKey;
  decision: ApprovalDecision;
  modifyText?: string;
  receivedAt: TimestampIso;
  channelThreadKey?: string;
}

export type BranchSuggestionDecision = "new_thread" | "continue";

export interface ChannelBranchSuggestionRequest {
  suggestionId: string;
  userKey: UserKey;
  channelThreadKey: string;
  text: string;
  expiresAt: TimestampIso;
  options: readonly BranchSuggestionDecision[];
}

export interface ChannelBranchSuggestionResponse {
  suggestionId: string;
  userKey: UserKey;
  channelThreadKey?: string;
  decision: BranchSuggestionDecision;
  receivedAt: TimestampIso;
}

export interface ChannelAcknowledgeRequest {
  channel: ChannelKind;
  userKey: UserKey;
  channelMessageId: ChannelMessageId;
  channelThreadKey?: string;
  kind: "received" | "typing";
}

export interface ChannelAdapter {
  readonly name: ChannelKind;
  readonly receive: AsyncIterable<NormalizedMessage>;
  readonly approvalResponses: AsyncIterable<ChannelApprovalResponse>;
  readonly branchSuggestionResponses?: AsyncIterable<ChannelBranchSuggestionResponse>;
  send(message: OutboundMessage): Promise<ChannelSendResult>;
  requestApproval(request: ChannelApprovalRequest): Promise<ChannelApprovalPrompt>;
  requestBranchSuggestion?(request: ChannelBranchSuggestionRequest): Promise<ChannelSendResult>;
  acknowledge?(request: ChannelAcknowledgeRequest): Promise<void>;
  close?(): Promise<void> | void;
}
