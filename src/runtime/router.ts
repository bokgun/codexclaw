import type { CodexRuntimeClient } from "../codex/runtime-client.js";
import { attachPrefsToText } from "../codex/input.js";
import { parseSchedule } from "./schedule.js";
import type { ThreadManager } from "../thread/thread-manager.js";
import type { PointerStore } from "../store/pointer-store.js";
import { RoutingError } from "./errors.js";
import type { ChannelName, ChannelSink, InboundMessage, PrefKey, RuntimeEvent, TaskRunStatus, ThreadRecord } from "./types.js";
import { TurnQueue } from "./turn-queue.js";

export interface RouterOptions {
  bindThread?: (thread: ThreadRecord, message: InboundMessage) => void;
  store?: PointerStore;
  channel?: ChannelName;
  minScheduleIntervalMs?: number;
  defaultTaskRetry?: number;
  defaultTaskTimeoutSec?: number;
}

export interface ScheduledRouteInput {
  taskId: string;
  userKey: string;
  channel: ChannelName;
  channelThreadKey?: string;
  label: string;
  text: string;
  timeoutSec: number;
}

export interface ScheduledRouteResult {
  taskId: string;
  threadId?: string;
  turnId?: string;
  status: Exclude<TaskRunStatus, "skipped_dedupe" | "skipped_channel">;
  reason?: string;
}

interface ScheduledWaiter {
  turnId?: string;
  resolve(event: Extract<RuntimeEvent, { kind: "turn_completed" | "turn_failed" }>): void;
  reject(error: Error): void;
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

      await this.enqueueFollowUp(thread, this.attachPrefs(message.userKey, message.text));
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

  async routeScheduled(input: ScheduledRouteInput): Promise<ScheduledRouteResult> {
    try {
      if (!this.connected) {
        return { taskId: input.taskId, status: "failed", reason: "Codex app-server is disconnected." };
      }

      const thread = await this.threads.resolveTaskThread(input.userKey, input.label);
      this.options.bindThread?.(thread, {
        channel: input.channel,
        channelMessageId: `task:${input.taskId}`,
        userKey: input.userKey,
        text: input.text,
        receivedAt: new Date().toISOString(),
        channelThreadKey: input.channelThreadKey
      });

      return await this.queue.enqueue(thread.threadId, async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let turnId: string | undefined;
        let pendingTerminal: Extract<RuntimeEvent, { kind: "turn_completed" | "turn_failed" }> | undefined;
        try {
          let timedOut = false;
          let abortScheduled!: (error: Error) => void;
          const aborted = new Promise<Error>((resolve) => {
            abortScheduled = resolve;
          });
          const timeoutReached = new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              timedOut = true;
              resolve();
            }, input.timeoutSec * 1000);
          });
          const terminal = new Promise<ScheduledRouteResult>((resolve) => {
            const resolveEvent = (event: Extract<RuntimeEvent, { kind: "turn_completed" | "turn_failed" }>): void => {
              resolve({
                taskId: input.taskId,
                threadId: thread.threadId,
                turnId: event.turnId,
                status: event.kind === "turn_completed" ? "succeeded" : "failed",
                reason: event.kind === "turn_failed" ? event.error ?? "Scheduled turn failed." : undefined
              });
            };
            this.scheduledWaiters.set(thread.threadId, {
              turnId,
              reject: (error) => {
                abortScheduled(error);
                resolve({
                  taskId: input.taskId,
                  threadId: thread.threadId,
                  turnId,
                  status: "failed",
                  reason: error.message
                });
              },
              resolve: (event) => {
                if (!turnId) {
                  pendingTerminal = event;
                  return;
                }
                if (event.turnId !== turnId) return;
                resolveEvent(event);
              }
            });
            if (pendingTerminal && pendingTerminal.turnId === turnId) resolveEvent(pendingTerminal);
          });
          const started = this.codex.startTurn(thread.threadId, this.attachPrefs(input.userKey, input.text)).then((startedTurnId) => {
            turnId = startedTurnId;
            const waiter = this.scheduledWaiters.get(thread.threadId);
            if (waiter) waiter.turnId = startedTurnId;
            this.threads.markRouted(thread);
            if (pendingTerminal && pendingTerminal.turnId === turnId) {
              this.scheduledWaiters.get(thread.threadId)?.resolve(pendingTerminal);
            }
            return startedTurnId;
          });
          await Promise.race([started, timeoutReached]);
          if (timedOut && !turnId) {
            const abortedStart = aborted.then((error) => {
              throw error;
            });
            await Promise.race([started, abortedStart]);
          }
          if (timedOut && turnId) {
            await this.codex.interruptTurn(thread.threadId, turnId).catch(() => undefined);
            return {
              taskId: input.taskId,
              threadId: thread.threadId,
              turnId,
              status: "timed_out",
              reason: "Scheduled turn timed out."
            };
          }
          const result = await Promise.race([
            terminal,
            timeoutReached.then((): ScheduledRouteResult => ({
              taskId: input.taskId,
              threadId: thread.threadId,
              turnId,
              status: "timed_out",
              reason: "Scheduled turn timed out."
            }))
          ]);
          if (result.status === "timed_out" && turnId) await this.codex.interruptTurn(thread.threadId, turnId).catch(() => undefined);
          return { ...result, turnId: result.turnId ?? turnId };
        } catch (error) {
          return {
            taskId: input.taskId,
            threadId: thread.threadId,
            turnId,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error)
          };
        } finally {
          if (timeout) clearTimeout(timeout);
          this.scheduledWaiters.delete(thread.threadId);
        }
      });
    } catch (error) {
      return {
        taskId: input.taskId,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  isThreadBusy(threadId: string): boolean {
    return this.queue.isBusy(threadId);
  }

  busyThreadIds(): string[] {
    return this.queue.busyThreadIds();
  }

  abortThread(threadId: string, reason: string): void {
    const waiter = this.scheduledWaiters.get(threadId);
    if (waiter) {
      this.scheduledWaiters.delete(threadId);
      waiter.reject(new Error(reason));
    }
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
      if (event.threadId) this.scheduledWaiters.get(event.threadId)?.resolve(event);
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
      case "/tasks":
        await this.handleTasksCommand(message, args);
        return;
      case "/prefs":
        await this.handlePrefsCommand(message, args);
        return;
      default:
        throw new RoutingError(`Unknown command '${command}'.`, "invalid_command");
    }
  }

  private readonly scheduledWaiters = new Map<string, ScheduledWaiter>();

  private async handleTasksCommand(message: InboundMessage, args: string[]): Promise<void> {
    const store = this.options.store;
    if (!store) throw new RoutingError("Tasks are not enabled in this runtime.", "capability_unavailable");
    const action = args[0];
    if (!action) throw new RoutingError("Usage: /tasks add|list|pause|reactivate|remove", "invalid_command");

    if (action === "list") {
      const tasks = store.listTasks(message.userKey);
      await this.sendText(
        message,
        tasks.length === 0
          ? "No scheduled tasks."
          : tasks
              .map(
                (task) =>
                  `${task.enabled ? "*" : " "} ${task.taskId} ${task.schedule} ${task.label} next=${task.nextRunAt} failures=${task.consecutiveFailures}`
              )
              .join("\n")
      );
      return;
    }

    if (action === "add") {
      const scheduleParts = args[1] === "every" ? 2 : looksLikeCronParts(args.slice(1, 6)) ? 5 : 1;
      const schedule = args.slice(1, 1 + scheduleParts).join(" ");
      const label = args[1 + scheduleParts];
      const taskText = args.slice(2 + scheduleParts).join(" ").trim();
      if (!schedule || !label || !taskText) {
        throw new RoutingError("Usage: /tasks add <schedule> <label> <prompt>", "invalid_command");
      }
      const parsed = parseSchedule(schedule, { minIntervalMs: this.options.minScheduleIntervalMs });
      await this.threads.resolveTaskThread(message.userKey, label);
      const task = store.createTask({
        userKey: message.userKey,
        label,
        channel: this.options.channel ?? message.channel,
        schedule: parsed.source,
        taskText,
        retry: this.options.defaultTaskRetry,
        timeoutSec: this.options.defaultTaskTimeoutSec,
        nextRunAt: parsed.nextAfter(new Date()).toISOString()
      });
      await this.sendText(message, `Created task ${task.taskId} for '${task.label}'.`);
      return;
    }

    const taskId = args[1];
    if (!taskId || args.length !== 2) throw new RoutingError(`Usage: /tasks ${action} <id>`, "invalid_command");
    const task = store.getTask(taskId);
    if (!task || task.userKey !== message.userKey) throw new RoutingError(`Unknown task '${taskId}'.`, "thread_not_found");
    if (action === "pause") {
      store.setTaskEnabled(taskId, false);
      await this.sendText(message, `Paused task ${taskId}.`);
      return;
    }
    if (action === "reactivate") {
      store.setTaskEnabled(taskId, true);
      await this.sendText(message, `Reactivated task ${taskId}.`);
      return;
    }
    if (action === "remove") {
      store.deleteTask(taskId);
      await this.sendText(message, `Removed task ${taskId}.`);
      return;
    }

    throw new RoutingError("Usage: /tasks add|list|pause|reactivate|remove", "invalid_command");
  }

  private async handlePrefsCommand(message: InboundMessage, args: string[]): Promise<void> {
    const store = this.options.store;
    if (!store) throw new RoutingError("Prefs are not enabled in this runtime.", "capability_unavailable");
    const action = args[0];
    if (action === "show") {
      const prefs = store.listPrefs(message.userKey);
      await this.sendText(
        message,
        prefs.length === 0 ? "No preferences set." : prefs.map((pref) => `${pref.key}=${pref.value}`).join("\n")
      );
      return;
    }
    if (action === "set") {
      const key = readPrefKey(args[1]);
      const value = args.slice(2).join(" ").trim();
      if (!key || !value) throw new RoutingError("Usage: /prefs set <lang|tone|verbosity> <value>", "invalid_command");
      store.setPref(message.userKey, key, value);
      await this.sendText(message, `Set ${key}.`);
      return;
    }
    if (action === "unset") {
      const key = readPrefKey(args[1]);
      if (!key || args.length !== 2) throw new RoutingError("Usage: /prefs unset <lang|tone|verbosity>", "invalid_command");
      store.unsetPref(message.userKey, key);
      await this.sendText(message, `Unset ${key}.`);
      return;
    }
    throw new RoutingError("Usage: /prefs show|set|unset", "invalid_command");
  }

  private attachPrefs(userKey: string, text: string): string {
    return this.options.store ? attachPrefsToText(text, this.options.store.listPrefs(userKey)) : text;
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

function readPrefKey(value: string | undefined): PrefKey | undefined {
  return value === "lang" || value === "tone" || value === "verbosity" ? value : undefined;
}

function looksLikeCronParts(parts: string[]): boolean {
  if (parts.length !== 5) return false;
  return parts.every((part, index) => {
    if (part === "*") return true;
    const parsed = Number.parseInt(part, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== part) return false;
    if (index === 0) return parsed >= 0 && parsed <= 59;
    if (index === 1) return parsed >= 0 && parsed <= 23;
    if (index === 2) return parsed >= 1 && parsed <= 31;
    if (index === 3) return parsed >= 1 && parsed <= 12;
    return parsed >= 0 && parsed <= 6;
  });
}
