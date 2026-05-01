import type { RuntimeLogger } from "./log.js";
import type { ChannelName, ChannelSink, RuntimeEvent, UserKey } from "./types.js";

export class EventDispatcher {
  private readonly threadTargets = new Map<
    string,
    { userKey: UserKey; channel: ChannelName; channelThreadKey?: string }
  >();

  constructor(
    private readonly channel: ChannelSink,
    private readonly logger: RuntimeLogger
  ) {}

  bindThread(
    threadId: string,
    target: { userKey: UserKey; channel: ChannelName; channelThreadKey?: string }
  ): void {
    this.threadTargets.set(threadId, target);
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
      return;
    }

    const eventThreadId = "threadId" in event ? event.threadId : undefined;
    if (eventThreadId) {
      const target = this.threadTargets.get(eventThreadId);
      const text = summarizeEvent(event);
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

    this.logger.debug("codex_event", {
      kind: event.kind,
      threadId: "threadId" in event ? event.threadId : undefined,
      turnId: "turnId" in event ? event.turnId : undefined
    });
  }
}

function summarizeEvent(event: RuntimeEvent): string | undefined {
  if (event.kind === "turn_started") return "Turn started.";
  if (event.kind === "turn_completed") return "Turn completed.";
  if (event.kind === "turn_failed") return "Turn failed.";
  if (event.kind === "diff_updated") return `Diff updated${event.size === undefined ? "." : ` (${event.size} bytes).`}`;
  if (event.kind === "tool_event") return `Tool event${event.status ? `: ${event.status}` : "."}`;
  return undefined;
}
