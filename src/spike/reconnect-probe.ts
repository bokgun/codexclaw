import { setTimeout as delay } from "node:timers/promises";
import {
  connectProbe,
  printEventSummary,
  requireObserved,
  startThread,
  startTurn,
  summarizeThreadTurnState,
  summarizeValue,
  waitForTurnTerminal
} from "./probe-utils.js";
import { JsonObject, JsonValue } from "../codex/ws-client.js";

const first = await connectProbe();
let threadId: string | undefined;
let originalTurnId: string | undefined;

try {
  threadId = await startThread(first.client, {});
  const turnResponse = await startTurn(
    first.client,
    threadId,
    [
      "M0 reconnect probe.",
      "Take a while before answering so the WebSocket can be closed mid-turn.",
      "Do not run commands or edit files."
    ].join(" ")
  );
  originalTurnId = readTurnId(turnResponse);
  console.error(`[probe] originalTurnId=${originalTurnId ?? "not_observed"}`);

  await delay(Number(process.env.CODEXCLAW_RECONNECT_AFTER_MS ?? 3_000));
  console.error("[probe] closing first socket without replaying prompt");
  first.client.close();

  await delay(Number(process.env.CODEXCLAW_RECONNECT_PAUSE_MS ?? 1_000));
} finally {
  first.client.close();
}

if (!threadId) throw new Error("thread id was not established before reconnect");

const second = await connectProbe();

try {
  const readResponse = await second.client.request("thread/read", { threadId, includeTurns: true });
  console.error(`[probe] post-reconnect thread/read ${summarizeValue(readResponse)}`);
  console.error(`[probe] post-reconnect ${summarizeThreadTurnState(readResponse, originalTurnId)}`);

  const resumeResponse = await second.client.request("thread/resume", { threadId, excludeTurns: true });
  console.error(`[probe] post-reconnect thread/resume ${summarizeValue(resumeResponse)}`);

  await startTurn(second.client, threadId, "M0 reconnect follow-up probe. Reply with exactly the word recovered.");
  const terminal = requireObserved(
    await waitForTurnTerminal(second.events, Number(process.env.CODEXCLAW_PROBE_TIMEOUT_MS ?? 120_000)),
    "reconnect follow-up terminal event"
  );
  console.error(`[probe] follow-up terminal=${terminal}`);

  console.error("[probe] original prompt was not replayed automatically");
  printEventSummary(second.events);
} finally {
  second.client.close();
}

function readTurnId(response: JsonValue): string | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const turn = (response as JsonObject).turn;
  if (turn && typeof turn === "object" && !Array.isArray(turn)) {
    const id = (turn as JsonObject).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}
