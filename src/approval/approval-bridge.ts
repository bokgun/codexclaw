import { randomUUID } from "node:crypto";
import { routeApprovalDecision } from "../channel/approval.js";
import type { ChannelAdapter, ChannelApprovalResponse } from "../channel/types.js";
import type { CodexRuntimeClient } from "../codex/runtime-client.js";
import type { JsonObject, JsonValue } from "../codex/ws-client.js";
import type { RuntimeLogger } from "../runtime/log.js";
import type { Router } from "../runtime/router.js";
import type { RuntimeEvent, ThreadRecord } from "../runtime/types.js";
import type { PointerStore } from "../store/pointer-store.js";

interface PendingRuntimeApproval {
  approvalId: string;
  requestId: number | string;
  method: string;
  thread: ThreadRecord;
  turnId?: string;
  context: string;
  userKey: string;
  channelMessageId?: string;
  channelThreadKey?: string;
  expiresAt?: string;
  prompt: string;
}

export class ApprovalBridge {
  private readonly pending = new Map<string, PendingRuntimeApproval>();
  private readonly activeByThread = new Map<string, string>();
  private readonly queuedByThread = new Map<string, PendingRuntimeApproval[]>();
  private readonly tombstones = new Map<string, { userKey: string; reason: string }>();

  constructor(
    private readonly store: PointerStore,
    private readonly codex: CodexRuntimeClient,
    private readonly channel: ChannelAdapter,
    private readonly router: Router,
  private readonly logger: RuntimeLogger,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now = () => new Date()
  ) {}

  async handleRuntimeEvent(event: RuntimeEvent): Promise<boolean> {
    if (event.kind !== "approval_requested") return false;

    const params = asObject(event.params);
    const threadId = readString(params, "threadId");
    const turnId = readString(params, "turnId");
    if (!threadId) {
      this.logger.warn("approval_missing_thread", { method: event.method });
      this.codex.sendApprovalResponse(event.method, event.requestId, false);
      return true;
    }

    const thread = this.findThread(threadId);
    if (!thread) {
      this.logger.warn("approval_thread_unmapped", { method: event.method, threadId });
      this.codex.sendApprovalResponse(event.method, event.requestId, false);
      return true;
    }

    const approvalId = `approval:${randomUUID()}`;
    const prompt = summarizeApprovalPrompt(event.method, params);
    const pending: PendingRuntimeApproval = {
      approvalId,
      requestId: event.requestId,
      method: event.method,
      thread,
      turnId,
      context: prompt,
      userKey: thread.userKey,
      channelThreadKey: undefined,
      prompt
    };
    this.pending.set(approvalId, pending);

    if (this.activeByThread.has(threadId)) {
      const queue = this.queuedByThread.get(threadId) ?? [];
      queue.push(pending);
      this.queuedByThread.set(threadId, queue);
      this.logger.info("approval_queued", { approvalId, threadId, method: event.method });
      return true;
    }

    await this.promptPending(pending);
    return true;
  }

  async handleChannelResponse(response: ChannelApprovalResponse): Promise<void> {
    const pending = this.pending.get(response.approvalId);
    if (!pending) {
      const tombstone = this.tombstones.get(response.approvalId);
      if (tombstone && tombstone.userKey === response.userKey) {
        await this.channel.send({
          channel: this.channel.name,
          userKey: response.userKey,
          text: `Approval ${response.approvalId} is no longer pending: ${tombstone.reason}.`,
          channelThreadKey: response.channelThreadKey,
          replyToMessageId: response.channelMessageId,
          attachments: [{ kind: "status", status: tombstone.reason }]
        });
        return;
      }
      this.logger.warn("approval_response_unmatched", { approvalId: response.approvalId });
      return;
    }
    if (!pending.channelMessageId || !pending.expiresAt) {
      this.logger.warn("approval_response_rejected", { approvalId: response.approvalId, reason: "not_active" });
      return;
    }
    if (
      response.userKey !== pending.userKey ||
      response.channelMessageId !== pending.channelMessageId ||
      (pending.channelThreadKey && response.channelThreadKey !== pending.channelThreadKey)
    ) {
      this.logger.warn("approval_response_rejected", { approvalId: response.approvalId, reason: "correlation_mismatch" });
      return;
    }
    if (this.now().toISOString() > pending.expiresAt) {
      this.resolvePending(pending, false, "approval_expired", { safe: true });
      this.notifyApprovalStatus(pending, "expired and was rejected");
      await this.promoteNext(pending.thread.threadId);
      return;
    }

    const routed = routeApprovalDecision(response);
    this.resolvePending(pending, routed.codexDecision === "accept", "approval_resolved");

    if (routed.followUpText) {
      await this.router.enqueueFollowUp(
        pending.thread,
        `The previous approval was rejected so this modified instruction can be applied instead.\n\nOriginal request summary:\n${pending.context}\n\nModified instruction:\n${routed.followUpText}`
      );
    }

    await this.promoteNext(pending.thread.threadId);
  }

  expirePending(now = this.now().toISOString()): void {
    for (const record of this.store.expirePendingApprovals(now)) {
      const pending = [...this.pending.values()].find((item) => item.channelMessageId === record.channelMsgId);
      if (!pending) continue;
      this.resolvePending(pending, false, "approval_expired", { safe: true });
      this.notifyApprovalStatus(pending, "expired and was rejected");
      void this.promoteNext(pending.thread.threadId);
    }
  }

  invalidateAll(reason: string): void {
    const approvals = [...this.pending.values()];
    this.pending.clear();
    this.activeByThread.clear();
    this.queuedByThread.clear();

    for (const pending of approvals) {
      this.tryDecline(pending, reason);
      this.tombstones.set(pending.approvalId, { userKey: pending.userKey, reason });
      if (pending.channelMessageId) this.store.deletePendingApproval(pending.channelMessageId);
      if (pending.channelMessageId) {
        void this.channel.send({
          channel: this.channel.name,
          userKey: pending.userKey,
          text: `Approval ${pending.approvalId} was invalidated: ${reason}.`,
          channelThreadKey: pending.channelThreadKey,
          replyToMessageId: pending.channelMessageId,
          attachments: [{ kind: "status", status: "invalidated" }]
        });
      }
      this.logger.warn("approval_invalidated", {
        approvalId: pending.approvalId,
        threadId: pending.thread.threadId,
        turnId: pending.turnId,
        reason
      });
    }
  }

  private async promptPending(pending: PendingRuntimeApproval): Promise<void> {
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    const promptResult = await this.channel.requestApproval({
      approvalId: pending.approvalId,
      userKey: pending.userKey,
      threadId: pending.thread.threadId,
      prompt: pending.prompt,
      options: ["approve", "reject", "modify"],
      expiresAt
    });

    const channelMessageId = promptResult.channelMessageId ?? pending.approvalId;
    pending.channelMessageId = channelMessageId;
    pending.expiresAt = expiresAt;
    this.activeByThread.set(pending.thread.threadId, pending.approvalId);
    this.store.savePendingApproval({
      channelMsgId: channelMessageId,
      userKey: pending.userKey,
      threadId: pending.thread.threadId,
      jsonrpcId: String(pending.requestId),
      approvalKind: pending.method,
      channel: this.channel.name,
      expiresAt
    });

    this.logger.info("approval_pending", {
      approvalId: pending.approvalId,
      threadId: pending.thread.threadId,
      method: pending.method
    });
  }

  private resolvePending(
    pending: PendingRuntimeApproval,
    accepted: boolean,
    event: string,
    options: { safe?: boolean } = {}
  ): void {
    if (options.safe) {
      this.trySendApprovalResponse(pending, accepted, event);
    } else {
      this.codex.sendApprovalResponse(pending.method, pending.requestId, accepted);
    }
    this.pending.delete(pending.approvalId);
    this.tombstones.set(pending.approvalId, { userKey: pending.userKey, reason: event });
    if (pending.channelMessageId) this.store.deletePendingApproval(pending.channelMessageId);
    if (this.activeByThread.get(pending.thread.threadId) === pending.approvalId) {
      this.activeByThread.delete(pending.thread.threadId);
    }
    this.logger.info(event, {
      approvalId: pending.approvalId,
      threadId: pending.thread.threadId,
      turnId: pending.turnId,
      method: pending.method
    });
  }

  private tryDecline(pending: PendingRuntimeApproval, reason: string): void {
    this.trySendApprovalResponse(pending, false, reason);
  }

  private trySendApprovalResponse(pending: PendingRuntimeApproval, accepted: boolean, reason: string): void {
    try {
      this.codex.sendApprovalResponse(pending.method, pending.requestId, accepted);
    } catch (error) {
      this.logger.warn("approval_response_send_failed", {
        approvalId: pending.approvalId,
        threadId: pending.thread.threadId,
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private notifyApprovalStatus(pending: PendingRuntimeApproval, status: string): void {
    if (!pending.channelMessageId) return;
    void this.channel.send({
      channel: this.channel.name,
      userKey: pending.userKey,
      text: `Approval ${pending.approvalId} ${status}.`,
      channelThreadKey: pending.channelThreadKey,
      replyToMessageId: pending.channelMessageId,
      attachments: [{ kind: "status", status }]
    });
  }

  private async promoteNext(threadId: string): Promise<void> {
    const queue = this.queuedByThread.get(threadId);
    const next = queue?.shift();
    if (!queue?.length) this.queuedByThread.delete(threadId);
    if (next) await this.promptPending(next);
  }

  private findThread(threadId: string): ThreadRecord | undefined {
    for (const userKey of this.knownUsers()) {
      const found = this.store.listThreads(userKey).find((thread) => thread.threadId === threadId);
      if (found) return found;
    }
    return undefined;
  }

  private knownUsers(): string[] {
    return this.store.db
      .query<{ user_key: string }, []>(`select distinct user_key from threads order by user_key`)
      .all()
      .map((row) => row.user_key);
  }
}

function summarizeApprovalPrompt(method: string, params: JsonObject): string {
  const reason = readString(params, "reason");
  const cwd = readString(params, "cwd");
  const grantRoot = readString(params, "grantRoot");
  const itemId = readString(params, "itemId");
  const command = readString(params, "command");
  const commandActions = params.commandActions;
  const parts = [`${method} requires approval.`];
  if (itemId) parts.push(`item: ${itemId}`);
  if (reason) parts.push(`reason: ${reason}`);
  if (command) parts.push(`command: ${command}`);
  if (Array.isArray(commandActions)) parts.push(`command actions: ${commandActions.length}`);
  if (cwd) parts.push(`cwd: ${cwd}`);
  if (grantRoot) parts.push(`root: ${grantRoot}`);
  return parts.join("\n");
}

function asObject(value: JsonValue): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function readString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}
