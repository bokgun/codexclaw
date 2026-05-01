import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectProbe,
  printEventSummary,
  requireNotification,
  requireObserved,
  startThread,
  startTurn,
  waitForTurnTerminal
} from "./probe-utils.js";
import { JsonObject, JsonValue, RpcInbound } from "../codex/ws-client.js";

const fixtureDir = await mkdtemp(join(tmpdir(), "codexclaw-m0-diff-tool-"));
const { client, events } = await connectProbe();

try {
  console.error(`[probe] fixture=${fixtureDir}`);
  const threadId = await startThread(client, {
    cwd: fixtureDir,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write"
  });

  await startTurn(
    client,
    threadId,
    [
      "M0 diff and tool event probe.",
      "In this disposable directory, create a file named probe-output.txt with one line.",
      "Then run exactly these two shell commands:",
      "printf 'm0 tool success\\n'",
      "sh -c 'echo m0 tool failure >&2; exit 7'",
      "Keep the final answer short."
    ].join(" "),
    { cwd: fixtureDir }
  );

  const terminal = requireObserved(
    await waitForTurnTerminal(events, Number(process.env.CODEXCLAW_PROBE_TIMEOUT_MS ?? 180_000)),
    "diff/tool turn terminal event"
  );
  console.error(`[probe] terminal=${terminal}`);

  requireNotification(events, "item/fileChange/outputDelta", "file-change output delta");
  requireNotification(events, "turn/diff/updated", "diff update");
  requireCommandCompletion(
    events,
    (item) => item.exitCode === 0 && typeof item.aggregatedOutput === "string",
    "successful command completion with aggregated output"
  );
  requireCommandCompletion(
    events,
    (item) =>
      (item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0)) &&
      typeof item.aggregatedOutput === "string",
    "failed command completion with aggregated output"
  );

  printEventSummary(events);
} finally {
  client.close();
  await rm(fixtureDir, { recursive: true, force: true });
}

function requireCommandCompletion(
  events: RpcInbound[],
  predicate: (item: JsonObject) => boolean,
  description: string
): void {
  const found = events.some((event) => {
    if (event.kind !== "notification" || event.method !== "item/completed") return false;
    const item = readItem(event.params);
    return !!item && isCommandItem(item) && predicate(item);
  });

  if (!found) throw new Error(`Did not observe ${description}`);
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
