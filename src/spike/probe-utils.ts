import { setTimeout as delay } from "node:timers/promises";
import { CodexWsClient, JsonObject, JsonValue, RpcInbound } from "../codex/ws-client.js";
import { textInput } from "../codex/input.js";
import { getCodexConnectionConfig } from "../config/env.js";

export interface ProbeClient {
  client: CodexWsClient;
  events: RpcInbound[];
}

export type ApprovalDecision = "accept" | "decline" | "cancel";

export async function connectProbe(): Promise<ProbeClient> {
  const { wsUrl, tokenFile } = getCodexConnectionConfig();
  const client = new CodexWsClient({ url: wsUrl, tokenFile });
  const events: RpcInbound[] = [];

  client.onInbound((message) => {
    events.push(message);
    console.error(formatInbound(message));
  });

  await client.connect();
  console.error(`[probe] connected url=${wsUrl}`);
  return { client, events };
}

export async function startThread(client: CodexWsClient, params: JsonObject = {}): Promise<string> {
  const response = (await client.request("thread/start", params)) as JsonObject;
  const threadId = readThreadId(response);

  console.error(`[probe] thread/start response ${summarizeValue(response)}`);
  if (!threadId) {
    throw new Error(`Unable to read thread id from thread/start response shape: ${summarizeValue(response)}`);
  }

  console.error(`[probe] thread=${threadId}`);
  return threadId;
}

export async function startTurn(
  client: CodexWsClient,
  threadId: string,
  prompt: string,
  params: JsonObject = {}
): Promise<JsonValue> {
  const payload = {
    threadId,
    input: [textInput(prompt)],
    ...params
  };

  console.error(`[probe] turn/start params ${summarizeValue(payload)}`);
  const response = await client.request("turn/start", payload);
  console.error(`[probe] turn/start response ${summarizeValue(response)}`);
  return response;
}

export async function waitForTurnTerminal(
  events: RpcInbound[],
  timeoutMs: number,
  startIndex = 0
): Promise<string | undefined> {
  return waitForNotification(events, (method) => isTerminalTurnMethod(method), timeoutMs, startIndex);
}

export async function waitForNotification(
  events: RpcInbound[],
  predicate: (method: string) => boolean,
  timeoutMs: number,
  startIndex = 0
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = events.slice(startIndex).find((event) => event.kind === "notification" && predicate(event.method));
    if (found?.kind === "notification") return found.method;
    await delay(250);
  }

  return undefined;
}

export async function waitForServerRequest(
  events: RpcInbound[],
  timeoutMs: number,
  predicate: (request: Extract<RpcInbound, { kind: "server_request" }>) => boolean = () => true
): Promise<Extract<RpcInbound, { kind: "server_request" }> | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = events.find((event) => event.kind === "server_request" && predicate(event));
    if (found?.kind === "server_request") return found;
    await delay(250);
  }

  return undefined;
}

export function requireObserved<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Timed out waiting for ${description}`);
  return value;
}

export function requireNotification(
  events: RpcInbound[],
  method: string,
  description = method,
  startIndex = 0
): Extract<RpcInbound, { kind: "notification" }> {
  const found = events
    .slice(startIndex)
    .find((event) => event.kind === "notification" && event.method === method);
  if (found?.kind === "notification") return found;
  throw new Error(`Did not observe ${description}`);
}

export function approvalResponseFor(method: string, decision: ApprovalDecision): JsonValue | undefined {
  if (method === "item/commandExecution/requestApproval") return { decision };
  if (method === "item/fileChange/requestApproval") return { decision };
  return undefined;
}

export function printEventSummary(events: RpcInbound[]): void {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = event.kind === "response" ? `response:${event.id}` : `${event.kind}:${event.method}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  console.error("[probe] event counts");
  for (const [key, count] of [...counts.entries()].sort()) {
    console.error(`  ${key} ${count}`);
  }
}

export function summarizeValue(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length}${value[0] === undefined ? "" : `, item=${summarizeValue(value[0])}`})`;

  const type = typeof value;
  if (type === "string") return `string(len=${(value as string).length})`;
  if (type === "number" || type === "boolean") return type;
  if (type !== "object") return type;

  const object = value as JsonObject;
  const entries = Object.entries(object);
  const fields = entries.slice(0, 16).map(([key, child]) => `${key}:${summarizeValue(child)}`);
  const suffix = entries.length > fields.length ? `, +${entries.length - fields.length}` : "";
  return `object{${fields.join(", ")}${suffix}}`;
}

export function readThreadId(response: JsonObject): string | undefined {
  if (typeof response.thread_id === "string") return response.thread_id;
  if (typeof response.threadId === "string") return response.threadId;

  const thread = response.thread;
  if (thread && typeof thread === "object" && !Array.isArray(thread)) {
    const id = (thread as JsonObject).id;
    if (typeof id === "string") return id;
  }

  return undefined;
}

export function summarizeThreadTurnState(response: JsonValue, turnId?: string): string {
  if (!response || typeof response !== "object" || Array.isArray(response)) return "thread_state=unreadable";
  const thread = (response as JsonObject).thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return "thread_state=missing_thread";

  const status = summarizeValue((thread as JsonObject).status);
  const turns = (thread as JsonObject).turns;
  if (!Array.isArray(turns)) return `thread_status=${status} turns=not_included`;

  const summaries = turns
    .filter((turn) => turn && typeof turn === "object" && !Array.isArray(turn))
    .map((turn) => {
      const object = turn as JsonObject;
      return {
        id: typeof object.id === "string" ? object.id : "unknown",
        status: typeof object.status === "string" ? object.status : summarizeValue(object.status),
        completedAt: object.completedAt === null ? "null" : typeof object.completedAt
      };
    });
  const target = turnId ? summaries.find((turn) => turn.id === turnId) : summaries.at(-1);
  const targetSummary = target
    ? `target_turn=${target.id}:${target.status}:completedAt=${target.completedAt}`
    : "target_turn=not_found";
  return `thread_status=${status} turns=${summaries.length} ${targetSummary}`;
}

function formatInbound(message: RpcInbound): string {
  if (message.kind === "response") {
    const payload = message.error ? message.error : message.result;
    return `[rpc:response] id=${message.id} ${summarizeValue(payload)}`;
  }

  if (message.kind === "server_request") {
    return `[rpc:server_request] id=${message.id} method=${message.method} params=${summarizeValue(message.params)}`;
  }

  return `[rpc:notification] method=${message.method} params=${summarizeValue(message.params)}`;
}

function isTerminalTurnMethod(method: string): boolean {
  return method === "turn/completed";
}
