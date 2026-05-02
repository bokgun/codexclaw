import { parseSchedule } from "./schedule.js";
import type { RuntimeLogger } from "./log.js";
import type { ChannelName, ChannelSink, TaskRecord, TaskRunStatus } from "./types.js";
import type { PointerStore } from "../store/pointer-store.js";
import type { Router, ScheduledRouteResult } from "./router.js";

export interface SchedulerOptions {
  store: PointerStore;
  router: Router;
  channel: ChannelName;
  logger: RuntimeLogger;
  channelSink?: ChannelSink;
  enabled?: boolean;
  tickIntervalMs?: number;
  failureThreshold?: number;
  minScheduleIntervalMs?: number;
  defaultRetry?: number;
  defaultTimeoutSec?: number;
  now?: () => Date;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_FAILURE_THRESHOLD = 5;

export class SchedulerCoordinator {
  private readonly tickIntervalMs: number;
  private readonly failureThreshold: number;
  private readonly minScheduleIntervalMs: number | undefined;
  private readonly now: () => Date;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly activeTasks = new Set<string>();

  constructor(private readonly options: SchedulerOptions) {
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.minScheduleIntervalMs = options.minScheduleIntervalMs;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.options.enabled === false || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.options.store.listDueTasks(this.options.channel, this.now().toISOString());
      for (const task of due) await this.runDueTask(task);
    } finally {
      this.running = false;
    }
  }

  private async runDueTask(task: TaskRecord): Promise<void> {
    const nextRunIso = nextRunAt(task, this.now(), this.minScheduleIntervalMs);
    if (task.channel !== this.options.channel) {
      this.options.store.markTaskSkipped(task.taskId, "skipped_channel", nextRunIso);
      return;
    }
    if (this.activeTasks.has(task.taskId)) {
      this.options.store.markTaskSkipped(task.taskId, "skipped_dedupe", nextRunIso);
      return;
    }

    this.activeTasks.add(task.taskId);
    this.options.store.markTaskRunStart(task.taskId, nextRunIso, this.now().toISOString());
    try {
      const result = await this.options.router.routeScheduled({
        taskId: task.taskId,
        userKey: task.userKey,
        channel: task.channel,
        label: task.label,
        text: task.taskText,
        timeoutSec: task.timeoutSec
      });
      await this.recordResult(task, result, nextRunIso);
    } catch (error) {
      this.options.logger.warn("scheduled_task_failed", {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error)
      });
      const updated = this.options.store.markTaskRunFailure(
        task.taskId,
        "failed",
        nextRunForFailure(task, this.now(), nextRunIso),
        this.failureThreshold,
        this.now().toISOString()
      );
      await this.notifyFailure(updated, error instanceof Error ? error.message : String(error));
    } finally {
      this.activeTasks.delete(task.taskId);
    }
  }

  private async recordResult(task: TaskRecord, result: ScheduledRouteResult, nextRunAt: string): Promise<void> {
    if (result.status === "succeeded") {
      this.options.store.markTaskRunSuccess(task.taskId, nextRunAt, this.now().toISOString());
      return;
    }

    const status: Extract<TaskRunStatus, "failed" | "timed_out"> = result.status === "timed_out" ? "timed_out" : "failed";
    const updated = this.options.store.markTaskRunFailure(
      task.taskId,
      status,
      nextRunForFailure(task, this.now(), nextRunAt),
      this.failureThreshold,
      this.now().toISOString()
    );
    this.options.logger.warn("scheduled_task_failed", {
      taskId: task.taskId,
      status,
      disabled: !updated.enabled,
      reason: result.reason
    });
    await this.notifyFailure(updated, result.reason);
  }

  private async notifyFailure(task: TaskRecord, reason: string | undefined): Promise<void> {
    if (!this.options.channelSink) return;
    const text = task.enabled
      ? `Task ${task.taskId} failed${reason ? `: ${reason}` : "."}`
      : `Task ${task.taskId} failed ${task.consecutiveFailures} times and was disabled. Reactivate it with /tasks reactivate ${task.taskId}.`;
    await this.options.channelSink.send({
      kind: "text",
      channel: task.channel,
      userKey: task.userKey,
      text
    });
  }
}

function nextRunAt(task: TaskRecord, after: Date, minScheduleIntervalMs: number | undefined): string {
  return parseSchedule(task.schedule, { minIntervalMs: minScheduleIntervalMs }).nextAfter(after).toISOString();
}

function nextRunForFailure(task: TaskRecord, after: Date, scheduledNextRunAt: string): string {
  if (task.consecutiveFailures >= task.retry) return scheduledNextRunAt;
  const backoffMs = Math.min(60_000, 2 ** task.consecutiveFailures * 1_000);
  return new Date(after.getTime() + backoffMs).toISOString();
}
