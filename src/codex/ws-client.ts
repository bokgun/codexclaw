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

type PendingRequest = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

export class CodexWsClient {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(event: RpcNotification) => void>();

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
        reject(new Error(`Unable to connect to Codex app-server at ${this.options.url}: ${error.message}`));
      };

      socket.once("open", onOpen);
      socket.once("error", onError);
    });

    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("close", () => this.rejectAll(new Error("Codex WebSocket closed")));
    this.socket.on("error", (error) => this.rejectAll(error));

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

  close(): void {
    this.socket?.close();
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonObject;
    const id = typeof message.id === "number" ? message.id : undefined;

    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;

      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result ?? null);
      }
      return;
    }

    if (typeof message.method === "string") {
      const event: RpcNotification = {
        method: message.method,
        params: message.params
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
}
