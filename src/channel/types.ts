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
  | { kind: "tasks"; action: "add"; schedule: string; label: string; text: string }
  | { kind: "tasks"; action: "list" }
  | { kind: "tasks"; action: "pause" | "reactivate" | "remove"; taskId: string }
  | { kind: "prefs"; action: "show" }
  | { kind: "prefs"; action: "set"; key: "lang" | "tone" | "verbosity"; value: string }
  | { kind: "prefs"; action: "unset"; key: "lang" | "tone" | "verbosity" }
  | { kind: "wiki"; action: "ingest"; paths: readonly string[]; visibility: "project_public" | "user_private"; slug?: string; focus?: string }
  | { kind: "wiki"; action: "note"; title: string; body: string; visibility: "project_public" | "user_private" }
  | { kind: "wiki"; action: "capture-selected"; text: string; visibility: "project_public" | "user_private"; slug?: string }
  | { kind: "wiki"; action: "query"; query: string; limit?: number }
  | { kind: "wiki"; action: "with"; query: string; message: string; limit?: number }
  | { kind: "wiki"; action: "lint"; writeReport: boolean }
  | { kind: "skills"; action: "list" }
  | { kind: "quit" };

export type ParsedChannelInput =
  | { kind: "command"; command: ChannelCommand }
  | { kind: "message"; message: NormalizedMessage };

export interface OutboundMessage {
  kind?: "text" | "agent_delta" | "status" | "document_delivery";
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
    }
  | {
      kind: "local_document";
      path: string;
      displayName?: string;
      sizeBytes?: number;
      dev?: number;
      ino?: number;
      mtimeMs?: number;
      contentType?: string;
      fallbackText?: string;
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
  recovery?: {
    channel: ChannelKind;
    channelMessageId: ChannelMessageId;
  };
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
  flushDeltas?(): Promise<void>;
  close?(): Promise<void> | void;
}
