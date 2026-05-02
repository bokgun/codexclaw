import { describe, expect, test } from "bun:test";
import { SchedulerCoordinator } from "../../src/runtime/scheduler.js";
import type { ScheduledRouteInput, ScheduledRouteResult } from "../../src/runtime/router.js";
import type { ChannelSink, OutboundEvent } from "../../src/runtime/types.js";
import { createPointerStore } from "../../src/store/pointer-store.js";

describe("SchedulerCoordinator", () => {
  test("routes due tasks and records success metadata", async () => {
    const store = createPointerStore();
    const router = new MockRouter("succeeded");
    const task = store.createTask({
      taskId: "task-ok",
      userKey: "user:1",
      label: "ops",
      channel: "cli",
      schedule: "every 5m",
      taskText: "check",
      nextRunAt: "2026-05-02T00:00:00.000Z"
    });

    const scheduler = new SchedulerCoordinator({
      store,
      router: router as never,
      channel: "cli",
      logger: new MemoryLogger() as never,
      now: () => new Date("2026-05-02T00:00:00.000Z")
    });
    await scheduler.tick();

    expect(router.inputs).toEqual([
      { taskId: task.taskId, userKey: "user:1", channel: "cli", channelThreadKey: undefined, label: "ops", text: "check", timeoutSec: 300 }
    ]);
    expect(store.getTask("task-ok")).toMatchObject({
      lastRunStatus: "succeeded",
      consecutiveFailures: 0,
      nextRunAt: "2026-05-02T00:05:00.000Z"
    });
    store.close();
  });

  test("records failures and disables after threshold", async () => {
    const store = createPointerStore();
    const router = new MockRouter("failed");
    const sink = new MemorySink();
    store.createTask({
      taskId: "task-bad",
      userKey: "user:1",
      label: "ops",
      channel: "cli",
      schedule: "every 5m",
      taskText: "check",
      nextRunAt: "2026-05-02T00:00:00.000Z"
    });

    const scheduler = new SchedulerCoordinator({
      store,
      router: router as never,
      channel: "cli",
      logger: new MemoryLogger() as never,
      channelSink: sink,
      failureThreshold: 1,
      now: () => new Date("2026-05-02T00:00:00.000Z")
    });
    await scheduler.tick();

    expect(store.getTask("task-bad")).toMatchObject({
      enabled: false,
      lastRunStatus: "failed",
      consecutiveFailures: 1
    });
    expect(sink.events.at(-1)?.text).toContain("was disabled");
    store.close();
  });
});

class MockRouter {
  inputs: ScheduledRouteInput[] = [];

  constructor(private readonly status: ScheduledRouteResult["status"]) {}

  async routeScheduled(input: ScheduledRouteInput): Promise<ScheduledRouteResult> {
    this.inputs.push(input);
    return { taskId: input.taskId, threadId: "thread-1", turnId: "turn-1", status: this.status };
  }
}

class MemoryLogger {
  warn(): void {}
  info(): void {}
  error(): void {}
  debug(): void {}
}

class MemorySink implements ChannelSink {
  events: Array<{ text: string }> = [];

  async send(event: OutboundEvent): Promise<void> {
    this.events.push({ text: "text" in event ? event.text : event.delta });
  }
}
