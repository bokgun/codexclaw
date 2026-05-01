import type { CodexRuntimeClient } from "../codex/runtime-client.js";
import type { ThreadManager } from "../thread/thread-manager.js";
import { RoutingError } from "./errors.js";
import type { ChannelSink, InboundMessage, RuntimeEvent, ThreadRecord } from "./types.js";
import { TurnQueue } from "./turn-queue.js";

export interface RouterOptions {
  bindThread?: (thread: ThreadRecord, message: InboundMessage) => void;
}

export class Router {
  private readonly queue = new TurnQueue();
  private connected = true;

  constructor(
    private readonly threads: ThreadManager,
    private readonly codex: CodexRuntimeClient,
    private readonly channel: ChannelSink,
    private readonly options: RouterOptions = {}
  ) {}

  async receive(message: InboundMessage): Promise<void> {
    const text = message.text.trim();
    if (!text) return;

    try {
      if (text.startsWith("/")) {
        await this.handleCommand(message, text);
        return;
      }

      if (!this.connected) throw new RoutingError("Codex app-server is disconnected; wait for reconnect before sending more work.", "disconnected");
      const thread = await this.threads.resolveRoutableThread(message.userKey);
      this.options.bindThread?.(thread, message);
      if (this.queue.isBusy(thread.threadId)) {
        await this.channel.send({
          kind: "status",
          channel: message.channel,
          userKey: message.userKey,
          channelThreadKey: message.channelThreadKey,
          text: `Queued for '${thread.label}' because a turn is already running.`
        });
      }

      await this.enqueueFollowUp(thread, message.text);
    } catch (error) {
      await this.channel.send({
        kind: "text",
        channel: message.channel,
        userKey: message.userKey,
        channelThreadKey: message.channelThreadKey,
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  isThreadBusy(threadId: string): boolean {
    return this.queue.isBusy(threadId);
  }

  busyThreadIds(): string[] {
    return this.queue.busyThreadIds();
  }

  abortThread(threadId: string, reason: string): void {
    this.queue.abortThread(threadId, reason);
  }

  enqueueFollowUp(thread: ThreadRecord, text: string): Promise<void> {
    return this.queue.enqueue(thread.threadId, async () => {
      const turnId = await this.codex.startTurn(thread.threadId, text);
      this.threads.markRouted(thread);
      await this.queue.waitForTerminal(thread.threadId, turnId);
    });
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.kind === "turn_completed" || event.kind === "turn_failed") {
      if (event.threadId) this.queue.resolveTerminal(event.threadId, event.turnId);
    }
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  private async handleCommand(message: InboundMessage, text: string): Promise<void> {
    const [command, ...args] = text.split(/\s+/);
    const label = args.join(" ").trim();

    switch (command) {
      case "/new": {
        const thread = await this.threads.createThread(message.userKey, label || undefined);
        await this.sendText(message, `Created and switched to '${thread.label}'.`);
        return;
      }
      case "/threads": {
        const threads = this.threads.listThreads(message.userKey);
        await this.sendText(
          message,
          threads.length === 0
            ? "No known threads."
            : threads.map((thread) => `${thread.isActive ? "*" : " "} ${thread.label} ${thread.status}`).join("\n")
        );
        return;
      }
      case "/switch": {
        if (!label) throw new RoutingError("Usage: /switch <label>", "invalid_command");
        const thread = await this.threads.switchThread(message.userKey, label);
        await this.sendText(message, `Switched to '${thread.label}'.`);
        return;
      }
      case "/branch": {
        const thread = await this.threads.branchThread(message.userKey, label || `branch-${Date.now()}`);
        await this.sendText(message, `Branched and switched to '${thread.label}'.`);
        return;
      }
      case "/archive": {
        if (!label) throw new RoutingError("Usage: /archive <label>", "invalid_command");
        const thread = await this.threads.archiveThread(message.userKey, label);
        await this.sendText(message, `Archived '${thread.label}'.`);
        return;
      }
      default:
        throw new RoutingError(`Unknown command '${command}'.`, "invalid_command");
    }
  }

  private async sendText(message: InboundMessage, text: string): Promise<void> {
    await this.channel.send({
      kind: "text",
      channel: message.channel,
      userKey: message.userKey,
      channelThreadKey: message.channelThreadKey,
      text
    });
  }
}
