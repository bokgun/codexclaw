import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  approvalResponseFor,
  ApprovalDecision,
  connectProbe,
  printEventSummary,
  requireObserved,
  startThread,
  startTurn,
  waitForServerRequest,
  waitForTurnTerminal
} from "./probe-utils.js";
import { JsonObject, JsonValue } from "../codex/ws-client.js";

const decision = readDecision();
const fixtureDir = await mkdtemp(join(tmpdir(), "codexclaw-m0-approval-"));
const { client, events } = await connectProbe();
let activeThreadId: string | undefined;
let activeTurnId: string | undefined;

client.onServerRequest((request) => {
  if (!isObservedApprovalMethod(request.method)) return;
  if (!requestMatchesActiveTurn(request.params)) {
    console.error(`[probe] ignoring out-of-scope approval request id=${request.id} method=${request.method}`);
    return;
  }

  const response = approvalResponseFor(request.method, decision);
  if (!response) {
    console.error(`[probe] unsupported approval request id=${request.id} method=${request.method}; not responding`);
    return;
  }

  console.error(`[probe] responding request id=${request.id} method=${request.method} decision=${decision}`);
  client.respond(request.id, response);
});

try {
  console.error(`[probe] fixture=${fixtureDir}`);
  const threadId = await startThread(client, {
    cwd: fixtureDir,
    approvalPolicy: "on-request",
    approvalsReviewer: "user"
  });
  activeThreadId = threadId;

  const turnResponse = await startTurn(
    client,
    threadId,
    readPrompt(),
    {
      cwd: fixtureDir,
      approvalPolicy: "on-request",
      approvalsReviewer: "user"
    }
  );
  activeTurnId = readTurnId(turnResponse) ?? activeTurnId;
  console.error(`[probe] activeTurnId=${activeTurnId ?? "not_observed"}`);

  const request = requireObserved(
    await waitForServerRequest(
      events,
      Number(process.env.CODEXCLAW_APPROVAL_WAIT_MS ?? 60_000),
      (candidate) => isObservedApprovalMethod(candidate.method) && requestMatchesActiveTurn(candidate.params)
    ),
    "approval server request"
  );
  console.error(`[probe] first server_request=${request.method} id=${request.id}`);

  const terminal = requireObserved(
    await waitForTurnTerminal(events, Number(process.env.CODEXCLAW_PROBE_TIMEOUT_MS ?? 180_000)),
    "approval turn terminal event"
  );
  console.error(`[probe] terminal=${terminal}`);
  printEventSummary(events);
} finally {
  client.close();
  await rm(fixtureDir, { recursive: true, force: true });
}

function readDecision(): ApprovalDecision {
  const value = process.env.CODEXCLAW_APPROVAL_DECISION ?? "decline";
  if (value === "accept" || value === "decline" || value === "cancel") return value;
  throw new Error("CODEXCLAW_APPROVAL_DECISION must be accept, decline, or cancel");
}

function readPrompt(): string {
  return (
    process.env.CODEXCLAW_APPROVAL_PROMPT ??
    [
      "M0 approval spike.",
      "Run exactly one shell command: printf 'm0 approval probe\\n'.",
      "If approval is required, request it.",
      "Do not inspect files, edit files, use network, or run any other command.",
      "After the command result, stop."
    ].join(" ")
  );
}

function isObservedApprovalMethod(method: string): boolean {
  return method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
}

function requestMatchesActiveTurn(params: JsonValue | undefined): boolean {
  if (!activeThreadId) return false;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;

  const object = params as JsonObject;
  if (object.threadId !== activeThreadId) return false;
  if (typeof object.itemId !== "string") return false;
  if (!activeTurnId && typeof object.turnId === "string") {
    activeTurnId = object.turnId;
  }
  if (activeTurnId && object.turnId !== activeTurnId) return false;
  if (!activeTurnId) return false;
  return true;
}

function readTurnId(response: JsonValue): string | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const object = response as JsonObject;
  if (typeof object.turnId === "string") return object.turnId;
  if (typeof object.turn_id === "string") return object.turn_id;

  const turn = object.turn;
  if (turn && typeof turn === "object" && !Array.isArray(turn)) {
    const id = (turn as JsonObject).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}
