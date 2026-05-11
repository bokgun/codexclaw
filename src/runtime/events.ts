import type { RuntimeLogger } from "./log.js";
import type { ChannelName, ChannelSink, RuntimeEvent, UserKey } from "./types.js";
import { FileDeliveryCollector, type FileDeliveryTurnBinding } from "./file-delivery.js";
import type { FileDeliveryPolicy, RejectedDocumentRef } from "./types.js";

export class EventDispatcher {
  private readonly threadTargets = new Map<
    string,
    { userKey: UserKey; channel: ChannelName; channelThreadKey?: string }
  >();
  private readonly fileDelivery?: { policy: FileDeliveryPolicy; collector: FileDeliveryCollector };

  constructor(
    private readonly channel: ChannelSink,
    private readonly logger: RuntimeLogger,
    options: { fileDeliveryPolicy?: FileDeliveryPolicy; fileDeliveryCollector?: FileDeliveryCollector } = {}
  ) {
    if (options.fileDeliveryPolicy) {
      this.fileDelivery = {
        policy: options.fileDeliveryPolicy,
        collector: options.fileDeliveryCollector ?? new FileDeliveryCollector()
      };
    }
  }

  bindThread(
    threadId: string,
    target: { userKey: UserKey; channel: ChannelName; channelThreadKey?: string },
    options: { fileDelivery?: FileDeliveryTurnBinding } = {}
  ): void {
    this.threadTargets.set(threadId, target);
    if (options.fileDelivery) this.fileDelivery?.collector.bindThread(threadId, options.fileDelivery);
    else this.fileDelivery?.collector.clearThread(threadId);
  }

  async dispatch(event: RuntimeEvent): Promise<void> {
    if (event.kind === "agent_delta" && event.threadId) {
      const target = this.threadTargets.get(event.threadId);
      if (target) {
        await this.channel.send({
          kind: "agent_delta",
          channel: target.channel,
          userKey: target.userKey,
          channelThreadKey: target.channelThreadKey,
          delta: event.delta
        });
      }
      this.fileDelivery?.collector.collectAgentDelta(event.threadId, event.turnId, event.delta, this.fileDelivery.policy);
      return;
    }

    if (event.kind === "turn_started" && event.threadId) {
      this.fileDelivery?.collector.startTurn(event.threadId, event.turnId);
    }

    if (event.kind === "file_change" && event.threadId) {
      this.fileDelivery?.collector.collectRuntimeFilePaths(event.threadId, event.turnId, event.paths, this.fileDelivery.policy);
      return;
    }

    const eventThreadId = "threadId" in event ? event.threadId : undefined;
    if (eventThreadId) {
      const target = this.threadTargets.get(eventThreadId);
      if (target && isChatChannel(target.channel) && isTerminalTurnEvent(event)) {
        await this.channel.flushDeltas?.();
      }
      if (target && event.kind === "turn_completed") {
        await this.dispatchDocumentDelivery(eventThreadId, event.turnId, target);
      } else if (event.kind === "turn_failed") {
        this.fileDelivery?.collector.clearThread(eventThreadId);
      }
      const text = target ? summarizeEvent(event, target.channel) : undefined;
      if (target && text) {
        await this.channel.send({
          kind: "status",
          channel: target.channel,
          userKey: target.userKey,
          channelThreadKey: target.channelThreadKey,
          text
        });
      }
    }

    if (event.kind === "unknown") {
      this.logger.debug("codex_unknown_event", { method: event.method });
      return;
    }

    if (event.kind === "skills_changed") {
      this.logger.debug("codex_event", { kind: event.kind });
      return;
    }

    this.logger.debug("codex_event", {
      kind: event.kind,
      threadId: "threadId" in event ? event.threadId : undefined,
      turnId: "turnId" in event ? event.turnId : undefined
    });
  }

  clearFileDelivery(): void {
    this.fileDelivery?.collector.clear();
  }

  private async dispatchDocumentDelivery(
    threadId: string,
    turnId: string | undefined,
    target: { userKey: UserKey; channel: ChannelName; channelThreadKey?: string }
  ): Promise<void> {
    if (target.channel !== "telegram" || !this.fileDelivery?.policy.enabled) {
      this.fileDelivery?.collector.clearThread(threadId);
      return;
    }
    const result = this.fileDelivery.collector.finishTurn(threadId, turnId, this.fileDelivery.policy);
    if (!result) return;
    const reasonCounts = countRejectedReasons(result.rejected);
    this.logger.debug("file_delivery_candidates_validated", {
      threadId,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
      reasons: reasonCounts
    });
    if (result.accepted.length > 0) {
      await this.channel.send({
        kind: "document_delivery",
        channel: target.channel,
        userKey: target.userKey,
        channelThreadKey: target.channelThreadKey,
        text: formatDeliveryText(result.accepted.length, result.rejected),
        documents: result.accepted
      });
      return;
    }
    if (result.rejected.length > 0) {
      await this.channel.send({
        kind: "status",
        channel: target.channel,
        userKey: target.userKey,
        channelThreadKey: target.channelThreadKey,
        text: `No deliverable document was found (${formatRejectedReasons(result.rejected)}).`
      });
    }
  }
}

function isTerminalTurnEvent(event: RuntimeEvent): boolean {
  return event.kind === "turn_completed" || event.kind === "turn_failed";
}

function summarizeEvent(event: RuntimeEvent, channel: ChannelName): string | undefined {
  if (isChatChannel(channel) && (event.kind === "turn_started" || event.kind === "turn_completed")) return undefined;
  if (event.kind === "turn_started") return "Turn started.";
  if (event.kind === "turn_completed") return "Turn completed.";
  if (event.kind === "turn_failed") return "Turn failed.";
  if (isChatChannel(channel) && (event.kind === "diff_updated" || event.kind === "tool_event")) return undefined;
  if (event.kind === "diff_updated") return `Diff updated${event.size === undefined ? "." : ` (${event.size} bytes).`}`;
  if (event.kind === "tool_event") return `Tool event${event.status ? `: ${event.status}` : "."}`;
  return undefined;
}

function isChatChannel(channel: ChannelName): boolean {
  return channel === "telegram" || channel === "discord";
}

function formatDeliveryText(count: number, rejected: readonly RejectedDocumentRef[]): string {
  const suffix = rejected.length > 0 ? ` ${rejected.length} candidate(s) were skipped: ${formatRejectedReasons(rejected)}.` : "";
  return `Delivering ${count} document${count === 1 ? "" : "s"}.${suffix}`;
}

function formatRejectedReasons(rejected: readonly RejectedDocumentRef[]): string {
  return rejected
    .slice(0, 5)
    .map((item) => `${item.displayPath}:${item.reason}`)
    .join(", ");
}

function countRejectedReasons(rejected: readonly RejectedDocumentRef[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of rejected) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return counts;
}
