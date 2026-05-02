import { describe, expect, test } from "bun:test";
import { parseSchedule } from "../../src/runtime/schedule.js";

describe("parseSchedule", () => {
  test("parses bounded interval schedules", () => {
    const parsed = parseSchedule("every 5m", { minIntervalMs: 60_000 });
    expect(parsed.kind).toBe("interval");
    expect(parsed.nextAfter(new Date("2026-05-02T00:00:00.000Z")).toISOString()).toBe("2026-05-02T00:05:00.000Z");
  });

  test("rejects schedules below the minimum interval", () => {
    expect(() => parseSchedule("every 30s", { minIntervalMs: 60_000 })).toThrow("at least 60 seconds");
  });

  test("parses simple five-field cron schedules", () => {
    const parsed = parseSchedule("0 * * * *");
    expect(parsed.kind).toBe("cron");
    expect(parsed.nextAfter(new Date("2026-05-02T00:30:30.000Z")).toISOString()).toBe("2026-05-02T01:00:00.000Z");
  });
});
