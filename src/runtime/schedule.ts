export interface ParsedSchedule {
  source: string;
  kind: "interval" | "cron";
  minIntervalMs: number;
  nextAfter(after: Date): Date;
}

const INTERVAL_PATTERN = /^every\s+(\d+)(s|m|h|d)$/i;
const CRON_PATTERN = /^([*]|\d{1,2})\s+([*]|\d{1,2})\s+([*]|\d{1,2})\s+([*]|\d{1,2})\s+([*]|\d)$/;

export function parseSchedule(source: string, options: { minIntervalMs?: number } = {}): ParsedSchedule {
  const trimmed = source.trim().replace(/\s+/g, " ");
  const interval = INTERVAL_PATTERN.exec(trimmed);
  if (interval) {
    const count = Number.parseInt(interval[1] ?? "", 10);
    const unit = interval[2]?.toLowerCase();
    const unitMs = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    const minIntervalMs = count * unitMs;
    enforceMinimum(minIntervalMs, options.minIntervalMs);
    return {
      source: trimmed,
      kind: "interval",
      minIntervalMs,
      nextAfter: (after) => new Date(after.getTime() + minIntervalMs)
    };
  }

  if (!CRON_PATTERN.test(trimmed)) {
    throw new Error("Schedule must be 'every <n>s|m|h|d' or a five-field cron expression.");
  }

  const parts = trimmed.split(" ");
  const minute = parseCronPart(parts[0] ?? "*", 0, 59, "minute");
  const hour = parseCronPart(parts[1] ?? "*", 0, 23, "hour");
  const day = parseCronPart(parts[2] ?? "*", 1, 31, "day");
  const month = parseCronPart(parts[3] ?? "*", 1, 12, "month");
  const weekday = parseCronPart(parts[4] ?? "*", 0, 6, "weekday");
  enforceMinimum(60_000, options.minIntervalMs);

  return {
    source: trimmed,
    kind: "cron",
    minIntervalMs: 60_000,
    nextAfter: (after) => nextCronDate(after, { minute, hour, day, month, weekday })
  };
}

function enforceMinimum(intervalMs: number, minimumMs = 60_000): void {
  if (intervalMs < minimumMs) {
    throw new Error(`Schedule interval must be at least ${Math.ceil(minimumMs / 1000)} seconds.`);
  }
}

function parseCronPart(value: string, min: number, max: number, name: string): number | undefined {
  if (value === "*") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max || String(parsed) !== value) {
    throw new Error(`Invalid cron ${name}.`);
  }
  return parsed;
}

function nextCronDate(
  after: Date,
  fields: { minute?: number; hour?: number; day?: number; month?: number; weekday?: number }
): Date {
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let attempts = 0; attempts < 527_040; attempts += 1) {
    if (
      (fields.minute === undefined || candidate.getUTCMinutes() === fields.minute) &&
      (fields.hour === undefined || candidate.getUTCHours() === fields.hour) &&
      (fields.day === undefined || candidate.getUTCDate() === fields.day) &&
      (fields.month === undefined || candidate.getUTCMonth() + 1 === fields.month) &&
      (fields.weekday === undefined || candidate.getUTCDay() === fields.weekday)
    ) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new Error("Unable to find next cron run within one year.");
}
