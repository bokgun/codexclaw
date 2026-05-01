import { setTimeout as delay } from "node:timers/promises";
import { JsonObject, JsonValue, RpcInbound } from "../codex/ws-client.js";
import {
  connectProbe,
  printEventSummary,
  requireObserved,
  startThread,
  startTurn,
  summarizeValue,
  waitForTurnTerminal
} from "./probe-utils.js";

const { client, events } = await connectProbe();

try {
  const threadId = await startThread(client, {});

  const firstStartIndex = events.length;
  await startTurn(
    client,
    threadId,
    [
      "M0 cancel probe.",
      "Run exactly one shell command: sleep 30.",
      "Do not run any other commands or edit files.",
      "Wait for the command to finish unless interrupted."
    ].join(" ")
  );

  await delay(Number(process.env.CODEXCLAW_CANCEL_AFTER_MS ?? 5_000));

  const turnId = requireObserved(readTurnIdFromEvents(), "turn id before interrupt");
  console.error(`[probe] turnId=${turnId}`);
  await waitForCommandStarted(
    events,
    Number(process.env.CODEXCLAW_CANCEL_COMMAND_WAIT_MS ?? 90_000),
    firstStartIndex
  );
  await delay(Number(process.env.CODEXCLAW_CANCEL_AFTER_COMMAND_MS ?? 1_000));

  const interruptSentAt = Date.now();
  try {
    const response = await client.request("turn/interrupt", { threadId, turnId });
    console.error(`[probe] turn/interrupt response ${summarizeValue(response)}`);
  } catch (error) {
    throw new Error(`turn/interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const terminal = requireObserved(
    await waitForTurnTerminal(events, Number(process.env.CODEXCLAW_PROBE_TIMEOUT_MS ?? 120_000), firstStartIndex),
    "interrupted turn terminal event"
  );
  console.error(`[probe] terminal=${terminal}`);
  const interruptElapsedMs = Date.now() - interruptSentAt;
  if (interruptElapsedMs > 25_000) {
    throw new Error(`Interrupted turn took too long to complete after interrupt: ${interruptElapsedMs}ms`);
  }
  assertNoNaturalSleepCompletion(events, firstStartIndex);

  const readResponse = await client.request("thread/read", { threadId, includeTurns: false });
  console.error(`[probe] thread/read response ${summarizeValue(readResponse)}`);

  const followUpStartIndex = events.length;
  await startTurn(client, threadId, "M0 cancel follow-up probe. Reply with exactly the word usable.");
  const followUpTerminal = requireObserved(
    await waitForTurnTerminal(events, Number(process.env.CODEXCLAW_PROBE_TIMEOUT_MS ?? 120_000), followUpStartIndex),
    "cancel follow-up terminal event"
  );
  console.error(`[probe] follow-up terminal=${followUpTerminal}`);

  printEventSummary(events);
} finally {
  client.close();
}

function readTurnIdFromEvents(): string | undefined {
  for (const event of events) {
    if (event.kind !== "notification" || event.method !== "turn/started") continue;
    const params = event.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) continue;
    const object = params as JsonObject;
    if (typeof object.turnId === "string") return object.turnId;
    if (typeof object.turn_id === "string") return object.turn_id;

    const turn = object.turn;
    if (turn && typeof turn === "object" && !Array.isArray(turn)) {
      const id = (turn as JsonObject).id;
      if (typeof id === "string") return id;
    }
  }

  return undefined;
}

function assertNoNaturalSleepCompletion(events: RpcInbound[], startIndex: number): void {
  const naturallyCompleted = events.slice(startIndex).some((event) => {
    if (event.kind !== "notification" || event.method !== "item/completed") return false;
    const item = readItem(event.params);
    return !!item && isCommandItem(item) && item.exitCode === 0;
  });

  if (naturallyCompleted) {
    throw new Error("Observed command exitCode 0 after interrupt; sleep may have completed naturally");
  }
}

async function waitForCommandStarted(events: RpcInbound[], timeoutMs: number, startIndex: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const started = events.slice(startIndex).some((event) => {
      if (event.kind !== "notification" || event.method !== "item/started") return false;
      const item = readItem(event.params);
      return !!item && isCommandItem(item);
    });
    if (started) return;
    await delay(250);
  }

  throw new Error("Timed out waiting for command item start before interrupt");
}

function readItem(params: JsonValue | undefined): JsonObject | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const object = params as JsonObject;
  const item = object.item;
  if (item && typeof item === "object" && !Array.isArray(item)) return item as JsonObject;
  return object;
}

function isCommandItem(item: JsonObject): boolean {
  return "command" in item || item.type === "commandExecution" || item.type === "command_execution";
}
