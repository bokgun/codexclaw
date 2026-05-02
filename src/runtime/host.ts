import { createCliChannelAdapter, type ChannelAdapter, type NormalizedMessage } from "../channel/index.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ApprovalBridge } from "../approval/approval-bridge.js";
import { CodexRuntimeClient } from "../codex/runtime-client.js";
import { CodexWsClient } from "../codex/ws-client.js";
import { getCodexConnectionConfig } from "../config/env.js";
import { createPointerStore, type PointerStore } from "../store/pointer-store.js";
import { ThreadManager } from "../thread/thread-manager.js";
import { BranchSuggestionCoordinator, type BranchSuggestionOptions } from "./branch-suggestion.js";
import { EventDispatcher } from "./events.js";
import { createJsonLineLogger, type RuntimeLogger } from "./log.js";
import { Router } from "./router.js";
import type { BranchSuggestionResponse, ChannelName, ChannelSink, InboundMessage, OutboundEvent, UserKey } from "./types.js";

export interface HostRuntimeOptions {
  channel?: ChannelAdapter;
  store?: PointerStore;
  logger?: RuntimeLogger;
  dbPath?: string;
  branchSuggestions?: BranchSuggestionOptions | false;
  approvalModifyTtlMs?: number;
}

type BranchSuggestionChannel = ChannelAdapter & {
  readonly branchSuggestionResponses?: AsyncIterable<BranchSuggestionResponse>;
};

export class HostRuntime {
  private readonly channel: ChannelAdapter;
  private readonly store: PointerStore;
  private readonly logger: RuntimeLogger;
  private readonly branchSuggestionOptions: BranchSuggestionOptions | false;
  private readonly approvalModifyTtlMs: number | undefined;
  private codex!: CodexRuntimeClient;
  private router!: Router;
  private approvals!: ApprovalBridge;
  private branchSuggestions?: BranchSuggestionCoordinator;
  private approvalExpiry?: ReturnType<typeof setInterval>;
  private reconnecting = false;
  private stopping = false;

  constructor(options: HostRuntimeOptions = {}) {
    const dbPath = options.dbPath ?? ".codexclaw/codexclaw.sqlite";
    this.logger = options.logger ?? createJsonLineLogger({ minLevel: "warn" });
    this.channel = options.channel ?? createCliChannelAdapter({ input: process.stdin, logger: this.logger });
    if (!options.store) mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.store = options.store ?? createPointerStore(dbPath);
    this.branchSuggestionOptions = options.branchSuggestions ?? false;
    this.approvalModifyTtlMs = options.approvalModifyTtlMs;
  }

  async start(): Promise<void> {
    const transport = await connectTransport();
    this.installCodexClient(transport);
    await this.resumeKnownActiveThreads();
    this.approvalExpiry = setInterval(() => this.approvals.expirePending(), 5_000);

    const pumps = [this.pumpMessages(), this.pumpApprovals()];
    const branchResponses = (this.channel as BranchSuggestionChannel).branchSuggestionResponses;
    if (this.branchSuggestions && branchResponses) pumps.push(this.pumpBranchSuggestions(branchResponses));
    await Promise.all(pumps);
  }

  private installCodexClient(transport: CodexWsClient): void {
    this.codex = new CodexRuntimeClient(transport);
    const sink = new ChannelAdapterSink(this.channel);
    const dispatcher = new EventDispatcher(sink, this.logger);
    const threadTargets = new Map<string, { userKey: UserKey; channel: ChannelName; channelThreadKey?: string }>();
    const threads = new ThreadManager(this.store, this.codex);
    this.router = new Router(threads, this.codex, sink, {
      bindThread: (thread, message) => {
        const target = {
          userKey: message.userKey,
          channel: message.channel,
          channelThreadKey: message.channelThreadKey
        };
        threadTargets.set(thread.threadId, target);
        dispatcher.bindThread(thread.threadId, target);
      }
    });
    this.approvals = new ApprovalBridge(this.store, this.codex, this.channel, this.router, this.logger, undefined, undefined, {
      getThreadTarget: (threadId) => threadTargets.get(threadId),
      modifyTtlMs: this.approvalModifyTtlMs
    });
    this.branchSuggestions =
      this.branchSuggestionOptions === false
        ? undefined
        : new BranchSuggestionCoordinator(this.store, sink, this.branchSuggestionOptions);

    this.codex.onEvent((event) => {
      this.router.handleRuntimeEvent(event);
      void this.approvals.handleRuntimeEvent(event);
      void dispatcher.dispatch(event);
    });
    this.codex.onClose((error) => {
      this.router.setConnected(false);
      if (this.stopping) return;
      this.logger.warn("codex_disconnected", { error: error?.message });
      this.approvals.invalidateAll("codex_disconnected");
      this.quarantineBusyThreads();
      void this.reconnect();
    });
  }

  close(): void {
    this.stopping = true;
    if (this.approvalExpiry) clearInterval(this.approvalExpiry);
    this.codex?.close();
    this.store.close();
    void this.channel.close?.();
  }

  private async pumpMessages(): Promise<void> {
    try {
      for await (const message of this.channel.receive) {
        if (message.channel === "cli" && (message.text.trim() === "/quit" || message.text.trim() === "/exit")) {
          this.close();
          break;
        }
        const inbound = toInboundMessage(message);
        const held = this.branchSuggestions ? await this.branchSuggestions.maybeHold(inbound) : false;
        if (!held) await this.router.receive(inbound);
      }
    } finally {
      void this.channel.close?.();
    }
  }

  private async pumpApprovals(): Promise<void> {
    for await (const response of this.channel.approvalResponses) {
      await this.approvals.handleChannelResponse(response);
    }
  }

  private async pumpBranchSuggestions(responses: AsyncIterable<BranchSuggestionResponse>): Promise<void> {
    for await (const response of responses) {
      await this.branchSuggestions?.handleResponse(response, (message) => this.router.receive(message));
    }
  }

  private quarantineBusyThreads(): void {
    for (const threadId of this.router.busyThreadIds()) {
      this.router.abortThread(threadId, "Codex app-server disconnected before turn completion");
      const thread = this.store.listAllThreads().find((record) => record.threadId === threadId);
      if (!thread) continue;
      this.store.markThreadStatus(thread.userKey, thread.label, "quarantined");
      this.logger.warn("thread_quarantined", { threadId, userKey: thread.userKey, label: thread.label });
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    let delayMs = 250;
    while (!this.stopping) {
      try {
        await delay(delayMs);
        if (this.stopping) break;
        const transport = await connectTransport();
        if (this.stopping) {
          transport.close();
          break;
        }
        this.installCodexClient(transport);
        await this.resumeKnownActiveThreads();
        if (this.stopping) break;
        this.router.setConnected(true);
        this.logger.info("codex_reconnected");
        this.reconnecting = false;
        return;
      } catch (error) {
        this.logger.warn("codex_reconnect_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        delayMs = Math.min(5_000, Math.floor(delayMs * 1.7));
      }
    }
    this.reconnecting = false;
  }

  private async resumeKnownActiveThreads(): Promise<void> {
    const threads = new ThreadManager(this.store, this.codex);
    for (const thread of this.store.listAllThreads().filter((record) => record.isActive && record.status === "active")) {
      const resumed = await threads.tryResumeThread(thread);
      if (!resumed) {
        this.logger.warn("thread_resume_failed", {
          threadId: thread.threadId,
          userKey: thread.userKey,
          label: thread.label
        });
      }
    }
  }
}

export async function runCliRuntime(): Promise<void> {
  const runtime = new HostRuntime();
  try {
    await runtime.start();
  } finally {
    runtime.close();
  }
}

async function connectTransport(): Promise<CodexWsClient> {
  const { wsUrl, tokenFile } = getCodexConnectionConfig();
  const client = new CodexWsClient({ url: wsUrl, tokenFile });
  await client.connect();
  return client;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInboundMessage(message: NormalizedMessage): InboundMessage {
  return {
    channel: message.channel,
    channelMessageId: message.id,
    userKey: message.userKey,
    text: message.text,
    receivedAt: message.receivedAt,
    channelThreadKey: message.channelThreadKey
  };
}

class ChannelAdapterSink implements ChannelSink {
  constructor(private readonly channel: ChannelAdapter) {}

  async flushDeltas(): Promise<void> {
    await this.channel.flushDeltas?.();
  }

  async send(event: OutboundEvent): Promise<{ channelMessageId?: string } | void> {
    if (event.kind === "approval_prompt") {
      return this.channel.requestApproval({
        approvalId: event.approvalId,
        userKey: event.userKey,
        threadId: "unknown",
        prompt: event.text,
        options: ["approve", "reject", "modify"],
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        channelThreadKey: event.channelThreadKey
      });
    }

    if (event.kind === "branch_suggestion") {
      if (this.channel.requestBranchSuggestion) {
        return this.channel.requestBranchSuggestion({
          suggestionId: event.suggestionId,
          userKey: event.userKey,
          channelThreadKey: event.channelThreadKey ?? event.userKey,
          text: event.text,
          expiresAt: event.expiresAt,
          options: event.options
        });
      }
      return this.channel.send({
        kind: "text",
        channel: event.channel,
        userKey: event.userKey,
        text: event.text,
        channelThreadKey: event.channelThreadKey
      });
    }

    return this.channel.send({
      kind: event.kind,
      channel: event.channel,
      userKey: event.userKey,
      text: event.kind === "agent_delta" ? event.delta : event.text,
      channelThreadKey: event.channelThreadKey
    });
  }
}
