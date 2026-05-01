import type { ThreadId } from "./types.js";

export type TurnTask<T> = () => Promise<T>;
type TerminalWaiter = {
  turnId?: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class TurnQueue {
  private readonly tails = new Map<ThreadId, Promise<unknown>>();
  private readonly depths = new Map<ThreadId, number>();
  private readonly terminalWaiters = new Map<ThreadId, TerminalWaiter[]>();
  private readonly completed = new Map<ThreadId, Set<string>>();

  isBusy(threadId: ThreadId): boolean {
    return (this.depths.get(threadId) ?? 0) > 0;
  }

  depth(threadId: ThreadId): number {
    return this.depths.get(threadId) ?? 0;
  }

  busyThreadIds(): ThreadId[] {
    return [...this.depths.entries()].filter(([, depth]) => depth > 0).map(([threadId]) => threadId);
  }

  enqueue<T>(threadId: ThreadId, task: TurnTask<T>): Promise<T> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    this.depths.set(threadId, this.depth(threadId) + 1);

    const current = previous.catch(() => undefined).then(task).finally(() => {
      const nextDepth = this.depth(threadId) - 1;
      if (nextDepth <= 0) {
        this.depths.delete(threadId);
        if (this.tails.get(threadId) === current) this.tails.delete(threadId);
      } else {
        this.depths.set(threadId, nextDepth);
      }
    });

    this.tails.set(threadId, current);
    return current;
  }

  waitForTerminal(threadId: ThreadId, turnId?: string): Promise<void> {
    if (this.consumeCompleted(threadId, turnId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = this.terminalWaiters.get(threadId) ?? [];
      waiters.push({ turnId, resolve, reject });
      this.terminalWaiters.set(threadId, waiters);
    });
  }

  resolveTerminal(threadId: ThreadId, turnId?: string): void {
    const waiters = this.terminalWaiters.get(threadId);
    if (!waiters?.length) {
      if (turnId) {
        const completed = this.completed.get(threadId) ?? new Set<string>();
        completed.add(turnId);
        this.completed.set(threadId, completed);
      }
      return;
    }

    const index = waiters.findIndex((waiter) => !waiter.turnId || !turnId || waiter.turnId === turnId);
    if (index === -1) return;

    const [waiter] = waiters.splice(index, 1);
    if (waiters.length === 0) this.terminalWaiters.delete(threadId);
    waiter?.resolve();
  }

  abortThread(threadId: ThreadId, reason: string): void {
    const error = new Error(reason);
    const waiters = this.terminalWaiters.get(threadId) ?? [];
    this.terminalWaiters.delete(threadId);
    this.completed.delete(threadId);
    this.tails.delete(threadId);
    this.depths.delete(threadId);
    for (const waiter of waiters) waiter.reject(error);
  }

  private consumeCompleted(threadId: ThreadId, turnId?: string): boolean {
    if (!turnId) return false;
    const completed = this.completed.get(threadId);
    if (!completed?.has(turnId)) return false;
    completed.delete(turnId);
    if (completed.size === 0) this.completed.delete(threadId);
    return true;
  }
}
