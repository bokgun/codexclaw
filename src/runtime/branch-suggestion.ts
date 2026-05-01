import { randomUUID } from "node:crypto";
import type { PointerStore } from "../store/pointer-store.js";
import type {
  BranchSuggestionResponse,
  ChannelSink,
  InboundMessage,
  ThreadRecord,
  TimestampIso
} from "./types.js";

interface HeldBranchSuggestion {
  suggestionId: string;
  message: InboundMessage;
  thread: ThreadRecord;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface BranchSuggestionOptions {
  idleMs?: number;
  dailyThrottleMs?: number;
  continueSuppressMs?: number;
  holdTtlMs?: number;
  now?: () => Date;
}

export type BranchSuggestionRoute = (message: InboundMessage) => Promise<void>;

export class BranchSuggestionCoordinator {
  private readonly held = new Map<string, HeldBranchSuggestion>();
  private readonly idleMs: number;
  private readonly dailyThrottleMs: number;
  private readonly continueSuppressMs: number;
  private readonly holdTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: PointerStore,
    private readonly sink: ChannelSink,
    options: BranchSuggestionOptions = {}
  ) {
    this.idleMs = options.idleMs ?? 4 * 60 * 60 * 1000;
    this.dailyThrottleMs = options.dailyThrottleMs ?? 24 * 60 * 60 * 1000;
    this.continueSuppressMs = options.continueSuppressMs ?? 7 * 24 * 60 * 60 * 1000;
    this.holdTtlMs = options.holdTtlMs ?? 5 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  async maybeHold(message: InboundMessage): Promise<boolean> {
    const text = message.text.trim();
    if (!text || text.startsWith("/")) return false;

    const active = this.store.getActiveThread(message.userKey);
    if (!active || !active.lastRoutedAt) return false;

    const now = this.now();
    if (!isBeforeOrEqual(active.lastRoutedAt, new Date(now.getTime() - this.idleMs).toISOString())) return false;
    if (active.suppressBranchUntil && active.suppressBranchUntil > now.toISOString()) return false;

    const lastUserSuggestion = this.store.getLastBranchSuggestedAt(message.userKey);
    if (
      lastUserSuggestion &&
      lastUserSuggestion > new Date(now.getTime() - this.dailyThrottleMs).toISOString()
    ) {
      return false;
    }

    const suggestionId = `branch:${randomUUID()}`;
    const held: HeldBranchSuggestion = {
      suggestionId,
      message,
      thread: active,
      expiresAt: now.getTime() + this.holdTtlMs
    };
    held.timer = setTimeout(() => {
      this.held.delete(suggestionId);
    }, this.holdTtlMs);
    if (typeof held.timer === "object" && held.timer && "unref" in held.timer) held.timer.unref();
    this.held.set(suggestionId, held);
    this.store.markBranchSuggested(active.userKey, active.label, now.toISOString());

    await this.sink.send({
      kind: "branch_suggestion",
      channel: message.channel,
      userKey: message.userKey,
      channelThreadKey: message.channelThreadKey,
      suggestionId,
      expiresAt: new Date(now.getTime() + this.holdTtlMs).toISOString(),
      text: "This thread has been idle for a while. Start a new thread or continue here?",
      options: ["new_thread", "continue"]
    });
    return true;
  }

  async handleResponse(response: BranchSuggestionResponse, route: BranchSuggestionRoute): Promise<void> {
    const held = this.held.get(response.suggestionId);
    if (!held) return;

    if (this.now().getTime() > held.expiresAt) {
      this.deleteHeld(response.suggestionId, held);
      return;
    }

    if (
      response.userKey !== held.message.userKey ||
      (held.message.channelThreadKey && response.channelThreadKey !== held.message.channelThreadKey)
    ) {
      return;
    }

    this.deleteHeld(response.suggestionId, held);
    if (response.decision === "new_thread") {
      await route({
        ...held.message,
        channelMessageId: `${held.message.channelMessageId}:branch-new`,
        text: "/new"
      });
      await route(held.message);
      return;
    }

    const suppressUntil = new Date(this.now().getTime() + this.continueSuppressMs).toISOString();
    this.store.setSuppressBranchUntil(held.thread.userKey, held.thread.label, suppressUntil);
    this.store.markBranchSuggested(held.thread.userKey, held.thread.label, this.now().toISOString());
    await route(held.message);
  }

  expireHeld(now = this.now().getTime()): void {
    for (const [suggestionId, held] of this.held) {
      if (now > held.expiresAt) this.deleteHeld(suggestionId, held);
    }
  }

  heldCount(): number {
    return this.held.size;
  }

  private deleteHeld(suggestionId: string, held: HeldBranchSuggestion): void {
    if (held.timer) clearTimeout(held.timer);
    this.held.delete(suggestionId);
  }
}

function isBeforeOrEqual(value: TimestampIso, threshold: TimestampIso): boolean {
  return value <= threshold;
}
