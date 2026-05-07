import { textInput } from "./input.js";
import type { CodexWsClient, JsonObject, JsonValue, RpcNotification, RpcServerRequest } from "./ws-client.js";
import { CapabilityError } from "../runtime/errors.js";
import type { RuntimeEvent, ThreadId, TurnId } from "../runtime/types.js";

export interface CodexThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  archived?: boolean | null;
  cwd?: string | readonly string[] | null;
  useStateDbOnly?: boolean;
}

export interface CodexThreadMetadata {
  id: string;
  status: unknown;
  cwd: string;
  archived?: boolean;
  turns?: readonly unknown[];
}

export interface CodexThreadListResponse {
  data: CodexThreadMetadata[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
}

export interface CodexThreadReadResponse {
  thread: CodexThreadMetadata;
}

export interface ThreadCapabilityProbeResult {
  list: boolean;
  archiveExternallyVerified: boolean;
  unarchiveExternallyVerified: boolean;
  notFoundShape?: string;
}

export const CODEX_METHODS = {
  threadStart: "thread/start",
  threadList: "thread/list",
  threadRead: "thread/read",
  threadResume: "thread/resume",
  threadFork: "thread/fork",
  threadArchive: "thread/archive",
  threadUnarchive: "thread/unarchive",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
  commandApproval: "item/commandExecution/requestApproval",
  fileApproval: "item/fileChange/requestApproval"
} as const;

export class CodexRuntimeClient {
  private readonly eventHandlers = new Set<(event: RuntimeEvent) => void>();
  private readonly capabilities: { forkThread: boolean; archiveThread: boolean; unarchiveThread: boolean };

  constructor(
    private readonly transport: CodexWsClient,
    options: { capabilities?: Partial<{ forkThread: boolean; archiveThread: boolean; unarchiveThread: boolean }> } = {}
  ) {
    this.capabilities = {
      forkThread: options.capabilities?.forkThread ?? false,
      archiveThread: options.capabilities?.archiveThread ?? false,
      unarchiveThread: options.capabilities?.unarchiveThread ?? false
    };
    this.transport.onNotification((notification) => this.handleNotification(notification));
    this.transport.onServerRequest((request) => this.handleServerRequest(request));
  }

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    return this.transport.onClose(handler);
  }

  close(): void {
    this.transport.close();
  }

  canForkThread(): boolean {
    return this.capabilities.forkThread;
  }

  canArchiveThread(): boolean {
    return this.capabilities.archiveThread;
  }

  canUnarchiveThread(): boolean {
    return this.capabilities.unarchiveThread;
  }

  async startThread(params: JsonObject = {}): Promise<ThreadId> {
    const response = (await this.transport.request(CODEX_METHODS.threadStart, params)) as JsonObject;
    const threadId = readThreadId(response);
    if (!threadId) throw new Error("thread/start response did not contain a thread id");
    return threadId;
  }

  async readThread(threadId: ThreadId, includeTurns = false): Promise<JsonValue> {
    return this.transport.request(CODEX_METHODS.threadRead, { threadId, includeTurns });
  }

  async readThreadMetadata(threadId: ThreadId): Promise<CodexThreadReadResponse> {
    return (await this.transport.request(CODEX_METHODS.threadRead, { threadId, includeTurns: false })) as unknown as CodexThreadReadResponse;
  }

  async listThreads(params: CodexThreadListParams): Promise<CodexThreadListResponse> {
    return (await this.transport.request(CODEX_METHODS.threadList, params as JsonObject)) as unknown as CodexThreadListResponse;
  }

  async probeThreadCapabilities(workspaceRoot: string): Promise<ThreadCapabilityProbeResult> {
    const result: ThreadCapabilityProbeResult = {
      list: false,
      archiveExternallyVerified: this.capabilities.archiveThread,
      unarchiveExternallyVerified: this.capabilities.unarchiveThread
    };

    try {
      await this.listThreads({ archived: false, cwd: workspaceRoot, limit: 1, useStateDbOnly: false });
      await this.listThreads({ archived: true, cwd: workspaceRoot, limit: 1, useStateDbOnly: false });
      result.list = true;
    } catch {
      return result;
    }

    try {
      await this.readThreadMetadata(`codexclaw-missing-${crypto.randomUUID()}`);
    } catch (error) {
      result.notFoundShape = boundedErrorShape(error);
    }

    return result;
  }

  async resumeThread(threadId: ThreadId, excludeTurns = true): Promise<JsonValue> {
    return this.transport.request(CODEX_METHODS.threadResume, { threadId, excludeTurns });
  }

  async forkThread(threadId: ThreadId): Promise<ThreadId> {
    if (!this.capabilities.forkThread) {
      throw new CapabilityError("thread/fork is not enabled because M0 has not verified it for this app-server");
    }
    const response = (await this.transport.request(CODEX_METHODS.threadFork, { threadId })) as JsonObject;
    const forkedId = readThreadId(response);
    if (!forkedId) throw new Error("thread/fork response did not contain a thread id");
    return forkedId;
  }

  async archiveThread(threadId: ThreadId): Promise<void> {
    if (!this.capabilities.archiveThread) {
      throw new CapabilityError("thread/archive is not enabled because M0 has not verified it for this app-server");
    }
    await this.transport.request(CODEX_METHODS.threadArchive, { threadId });
  }

  async unarchiveThread(threadId: ThreadId): Promise<void> {
    if (!this.capabilities.unarchiveThread) {
      throw new CapabilityError("thread/unarchive is not enabled because M4b has not verified it for this app-server");
    }
    await this.transport.request(CODEX_METHODS.threadUnarchive, { threadId });
  }

  async startTurn(threadId: ThreadId, text: string): Promise<TurnId | undefined> {
    const response = (await this.transport.request(CODEX_METHODS.turnStart, {
      threadId,
      input: [textInput(text)]
    })) as JsonObject;
    return readTurnId(response);
  }

  async interruptTurn(threadId: ThreadId, turnId: TurnId): Promise<void> {
    await this.transport.request(CODEX_METHODS.turnInterrupt, { threadId, turnId });
  }

  sendApprovalResponse(method: string, requestId: number | string, accepted: boolean): void {
    if (!isObservedApprovalMethod(method)) {
      throw new CapabilityError(`Unsupported approval method '${method}'`);
    }
    this.transport.respond(requestId, { decision: accepted ? "accept" : "decline" });
  }

  private handleServerRequest(request: RpcServerRequest): void {
    if (isObservedApprovalMethod(request.method)) {
      this.emit({
        kind: "approval_requested",
        requestId: request.id,
        method: request.method,
        params: request.params ?? null
      });
      return;
    }

    this.transport.respondError(request.id, {
      code: -32601,
      message: `Unsupported server request method: ${request.method}`
    });
    this.emit({ kind: "unknown", method: request.method, params: request.params });
  }

  private handleNotification(notification: RpcNotification): void {
    const params = asObject(notification.params);
    const threadId = readString(params, "threadId");
    const turnId = readString(params, "turnId") ?? readNestedTurnId(params);

    switch (notification.method) {
      case "item/agentMessage/delta": {
        const delta = readString(params, "delta");
        if (delta) this.emit({ kind: "agent_delta", threadId, turnId, delta });
        return;
      }
      case "turn/started":
        this.emit({ kind: "turn_started", threadId, turnId });
        return;
      case "turn/completed":
        this.emit({ kind: "turn_completed", threadId, turnId });
        return;
      case "turn/diff/updated": {
        const diff = readString(params, "diff");
        this.emit({ kind: "diff_updated", threadId, turnId, size: diff?.length });
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = asObject(params.item);
        this.emit({
          kind: "tool_event",
          threadId,
          turnId,
          itemId: readString(params, "itemId") ?? readString(item, "id"),
          status: readString(item, "status")
        });
        return;
      }
      case "error":
        this.emit({ kind: "turn_failed", threadId, turnId, error: JSON.stringify(notification.params ?? null) });
        return;
      default:
        this.emit({ kind: "unknown", method: notification.method, params: notification.params });
    }
  }

  private emit(event: RuntimeEvent): void {
    for (const handler of this.eventHandlers) handler(event);
  }
}

export function isObservedApprovalMethod(method: string): boolean {
  return method === CODEX_METHODS.commandApproval || method === CODEX_METHODS.fileApproval;
}

function readThreadId(response: JsonObject): string | undefined {
  if (typeof response.thread_id === "string") return response.thread_id;
  if (typeof response.threadId === "string") return response.threadId;
  const thread = asObject(response.thread);
  return readString(thread, "id");
}

function readTurnId(response: JsonObject): string | undefined {
  if (typeof response.turn_id === "string") return response.turn_id;
  if (typeof response.turnId === "string") return response.turnId;
  const turn = asObject(response.turn);
  return readString(turn, "id");
}

function readNestedTurnId(params: JsonObject): string | undefined {
  const turn = asObject(params.turn);
  return readString(turn, "id");
}

function asObject(value: JsonValue | undefined): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function readString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function boundedErrorShape(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`.slice(0, 160);
  return String(error).slice(0, 160);
}
