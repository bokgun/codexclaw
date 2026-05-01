import { readFile } from "node:fs/promises";
import WebSocket from "ws";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface CodexClientOptions {
  url: string;
  tokenFile: string;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
}

export interface RpcNotification {
  method: string;
  params?: JsonValue;
}

export type RpcInbound =
  | {
      kind: "response";
      id: number | string;
      result?: JsonValue;
      error?: JsonValue;
    }
  | {
      kind: "notification";
      method: string;
      params?: JsonValue;
    }
  | {
      kind: "server_request";
      id: number | string;
      method: string;
      params?: JsonValue;
    };

export interface RpcServerRequest {
  id: number | string;
  method: string;
  params?: JsonValue;
}

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

export class CodexWsClient {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly inboundHandlers = new Set<(message: RpcInbound) => void>();
  private readonly notificationHandlers = new Set<(event: RpcNotification) => void>();
  private readonly serverRequestHandlers = new Set<(request: RpcServerRequest) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();

  constructor(private readonly options: CodexClientOptions) {}

  async connect(): Promise<void> {
    const token = (await readFile(this.options.tokenFile, "utf8")).trim();
    this.socket = new WebSocket(this.options.url, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    this.socket.on("error", () => {
      // Keep connection failures as rejected promises instead of unhandled EventEmitter errors.
    });

    await new Promise<void>((resolve, reject) => {
      const socket = this.requireSocket();
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(`Unable to connect to Codex app-server: ${error.message}`));
      };

      socket.once("open", onOpen);
      socket.once("error", onError);
    });

    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("close", () => this.handleClose(new Error("Codex WebSocket closed")));
    this.socket.on("error", (error) => this.handleClose(error));

    await this.request("initialize", {
      clientInfo: {
        name: this.options.clientName ?? "codexclaw",
        title: this.options.clientTitle ?? "codexclaw",
        version: this.options.clientVersion ?? "0.0.0"
      }
    });
    this.notify("initialized", {});
  }

  onNotification(handler: (event: RpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onInbound(handler: (message: RpcInbound) => void): () => void {
    this.inboundHandlers.add(handler);
    return () => this.inboundHandlers.delete(handler);
  }

  onServerRequest(handler: (request: RpcServerRequest) => void): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  request(method: string, params?: JsonValue): Promise<JsonValue> {
    const id = this.nextId++;
    const socket = this.requireOpenSocket();
    const payload = params === undefined ? { id, method } : { id, method, params };

    socket.send(JSON.stringify(payload));

    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method: string, params?: JsonValue): void {
    const socket = this.requireOpenSocket();
    const payload = params === undefined ? { method } : { method, params };
    socket.send(JSON.stringify(payload));
  }

  respond(id: number | string, result?: JsonValue): void {
    const socket = this.requireOpenSocket();
    const payload = result === undefined ? { id, result: null } : { id, result };
    socket.send(JSON.stringify(payload));
  }

  respondError(id: number | string, error: JsonValue): void {
    const socket = this.requireOpenSocket();
    socket.send(JSON.stringify({ id, error }));
  }

  close(): void {
    this.socket?.close();
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonObject;
    const inbound = classifyInbound(message);

    for (const handler of this.inboundHandlers) handler(inbound);

    if (inbound.kind === "response") {
      if (typeof inbound.id !== "number") return;

      const pending = this.pending.get(inbound.id);
      if (!pending) return;

      this.pending.delete(inbound.id);
      if (inbound.error) {
        pending.reject(new Error(JSON.stringify(inbound.error)));
      } else {
        pending.resolve(inbound.result ?? null);
      }
      return;
    }

    if (inbound.kind === "server_request") {
      for (const handler of this.serverRequestHandlers) handler(inbound);
      return;
    }

    if (inbound.kind === "notification") {
      const event: RpcNotification = {
        method: inbound.method,
        params: inbound.params
      };
      for (const handler of this.notificationHandlers) handler(event);
    }
  }

  private requireSocket(): WebSocket {
    if (!this.socket) throw new Error("Codex WebSocket is not connected");
    return this.socket;
  }

  private requireOpenSocket(): WebSocket {
    const socket = this.requireSocket();
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex WebSocket is not open");
    }
    return socket;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handleClose(error: Error): void {
    this.rejectAll(error);
    for (const handler of this.closeHandlers) handler(error);
  }
}

function classifyInbound(message: JsonObject): RpcInbound {
  const id = readRpcId(message);
  const method = typeof message.method === "string" ? message.method : undefined;

  if (id !== undefined && method) {
    return { kind: "server_request", id, method, params: message.params };
  }

  if (id !== undefined) {
    return { kind: "response", id, result: message.result, error: message.error };
  }

  if (method) {
    return { kind: "notification", method, params: message.params };
  }

  return {
    kind: "notification",
    method: "unknown",
    params: message
  };
}

function readRpcId(message: JsonObject): number | string | undefined {
  if (typeof message.id === "number" || typeof message.id === "string") return message.id;
  return undefined;
}
