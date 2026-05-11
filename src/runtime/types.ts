import type { JsonValue } from "../codex/ws-client.js";

export type UserKey = string;
export type ThreadId = string;
export type TurnId = string;
export type ThreadLabel = string;
export type TimestampIso = string;
export type ChannelName = "cli" | "telegram" | "discord";

export type ThreadRouteStatus = "active" | "archived" | "missing" | "quarantined";
export type ApprovalDecisionKind = "approve" | "reject" | "modify";
export type RuntimeErrorCode =
  | "thread_not_found"
  | "thread_not_routable"
  | "approval_not_found"
  | "store_constraint"
  | "invalid_config"
  | "capability_unavailable";

export interface InboundMessage {
  channel: ChannelName;
  channelMessageId: string;
  userKey: UserKey;
  text: string;
  receivedAt: TimestampIso;
  channelThreadKey?: string;
}

export type BranchSuggestionDecisionKind = "new_thread" | "continue";

export interface BranchSuggestionResponse {
  suggestionId: string;
  userKey: UserKey;
  decision: BranchSuggestionDecisionKind;
  receivedAt: TimestampIso;
  channelThreadKey?: string;
}

export type OutboundEvent =
  | {
      kind: "text";
      channel: ChannelName;
      userKey: UserKey;
      text: string;
      channelThreadKey?: string;
    }
  | {
      kind: "agent_delta";
      channel: ChannelName;
      userKey: UserKey;
      delta: string;
      channelThreadKey?: string;
    }
  | {
      kind: "status";
      channel: ChannelName;
      userKey: UserKey;
      text: string;
      channelThreadKey?: string;
    }
  | {
      kind: "approval_prompt";
      channel: ChannelName;
      userKey: UserKey;
      approvalId: string;
      text: string;
      channelThreadKey?: string;
    }
  | {
      kind: "branch_suggestion";
      channel: ChannelName;
      userKey: UserKey;
      suggestionId: string;
      text: string;
      expiresAt: TimestampIso;
      options: readonly BranchSuggestionDecisionKind[];
      channelThreadKey?: string;
    }
  | {
      kind: "document_delivery";
      channel: ChannelName;
      userKey: UserKey;
      text: string;
      documents: readonly LocalDocumentRef[];
      channelThreadKey?: string;
    };

export interface ChannelSink {
  send(event: OutboundEvent): Promise<{ channelMessageId?: string } | void>;
  flushDeltas?(): Promise<void>;
}

export interface LocalDocumentRef {
  absolutePath: string;
  displayName: string;
  sizeBytes: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  contentType?: string;
  source: "runtime_file_metadata";
}

export interface RejectedDocumentRef {
  displayPath: string;
  reason:
    | "outside_allowed_roots"
    | "missing"
    | "not_regular_file"
    | "too_large"
    | "denied_path"
    | "symlink_escape"
    | "duplicate"
      | "limit_exceeded";
}

export interface FileDeliveryPolicy {
  enabled: boolean;
  allowedRoots: readonly string[];
  deniedRoots: readonly string[];
  deniedSegments: readonly string[];
  maxFileBytes: number;
  maxFilesPerTurn: number;
  workspaceRoot: string;
  maxCandidatesPerTurn: number;
}

export interface ThreadRecord {
  userKey: UserKey;
  label: ThreadLabel;
  threadId: ThreadId;
  status: ThreadRouteStatus;
  isDefault: boolean;
  isActive: boolean;
  lastRoutedAt?: TimestampIso;
  suppressBranchUntil?: TimestampIso;
  lastBranchSuggestedAt?: TimestampIso;
  createdAt: TimestampIso;
  updatedAt: TimestampIso;
}

export interface PendingApprovalRecord {
  channelMsgId: string;
  userKey: UserKey;
  threadId: ThreadId;
  jsonrpcId: string;
  jsonrpcIdType: "number" | "string";
  hostInstanceId?: string;
  approvalKind: string;
  channel: ChannelName;
  expiresAt: TimestampIso;
  createdAt: TimestampIso;
}

export interface ApprovalResponse {
  channelMsgId: string;
  decision: ApprovalDecisionKind;
  modifiedInstruction?: string;
}

export interface RuntimeConfig {
  dbPath: string;
  approvalTtlMs: number;
}

export type RuntimeEvent =
  | { kind: "agent_delta"; threadId?: ThreadId; turnId?: TurnId; delta: string }
  | { kind: "turn_started"; threadId?: ThreadId; turnId?: TurnId }
  | { kind: "turn_completed"; threadId?: ThreadId; turnId?: TurnId }
  | { kind: "turn_failed"; threadId?: ThreadId; turnId?: TurnId; error?: string }
  | { kind: "diff_updated"; threadId?: ThreadId; turnId?: TurnId; size?: number }
  | { kind: "file_change"; threadId?: ThreadId; turnId?: TurnId; paths: readonly string[] }
  | { kind: "tool_event"; threadId?: ThreadId; turnId?: TurnId; itemId?: string; status?: string }
  | { kind: "approval_requested"; requestId: number | string; method: string; params: JsonValue }
  | { kind: "skills_changed" }
  | { kind: "unknown"; method: string; params?: JsonValue };

export type TaskDedupePolicy = "concurrency_1";
export type TaskRunStatus = "succeeded" | "failed" | "skipped_dedupe" | "timed_out" | "skipped_channel";

export interface TaskRecord {
  taskId: string;
  userKey: UserKey;
  label: ThreadLabel;
  channel: ChannelName;
  schedule: string;
  taskText: string;
  enabled: boolean;
  retry: number;
  timeoutSec: number;
  dedupePolicy: TaskDedupePolicy;
  lastRunAt?: TimestampIso;
  lastRunStatus?: TaskRunStatus;
  consecutiveFailures: number;
  nextRunAt: TimestampIso;
  createdAt: TimestampIso;
  updatedAt: TimestampIso;
}

export type PrefKey = "lang" | "tone" | "verbosity";

export interface PrefRecord {
  userKey: UserKey;
  key: PrefKey;
  value: string;
  updatedAt: TimestampIso;
}
