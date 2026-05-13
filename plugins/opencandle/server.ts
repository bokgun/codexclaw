import { realpathSync, statSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: JsonValue;
}

interface FearGreedData {
  value: number;
  label: string;
}

interface FearGreedProvider {
  getFearGreedIndex(): Promise<FearGreedData>;
}

export interface OpenCandleMcpServerOptions {
  provider?: FearGreedProvider;
  env?: Readonly<Record<string, string | undefined>>;
}

const serverInfo = {
  name: "codexclaw-opencandle-mcp",
  version: "0.1.0"
};

const tool = {
  name: "get_fear_greed",
  title: "OpenCandle Fear And Greed",
  description: "Fetches OpenCandle's crypto Fear and Greed index provider.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
} as const;

export function createOpenCandleMcpServer(options: OpenCandleMcpServerOptions = {}) {
  const provider = options.provider ?? createOpenCandleProvider(options.env ?? process.env);

  async function dispatch(method: string, params: JsonValue | undefined): Promise<JsonValue> {
    if (method === "initialize") {
      const protocolVersion = readObject(params)?.protocolVersion;
      return {
        protocolVersion: typeof protocolVersion === "string" ? protocolVersion : "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo
      };
    }

    if (method === "ping") return {};

    if (method === "tools/list") {
      return {
        tools: [tool]
      };
    }

    if (method === "tools/call") {
      const object = readObject(params);
      if (object?.name !== "get_fear_greed") throw new Error("unknown OpenCandle tool");

      const args = object.arguments === undefined ? {} : readObject(object.arguments);
      if (!args) throw new Error("get_fear_greed arguments must be an object");
      if (Object.keys(args).length > 0) throw new Error("get_fear_greed does not accept arguments");

      const quote = boundedFearGreedData(await provider.getFearGreedIndex());
      return {
        content: [
          {
            type: "text",
            text: `Crypto Fear and Greed: ${quote.value} (${quote.label})`
          }
        ],
        structuredContent: {
          value: quote.value,
          label: quote.label,
          provider: "opencandle",
          source: "alternative.me"
        },
        isError: false
      };
    }

    if (method === "resources/list") return { resources: [] };
    if (method === "prompts/list") return { prompts: [] };

    throw new Error(`unsupported method ${method}`);
  }

  async function handleMessage(message: RpcMessage): Promise<JsonObject | undefined> {
    if (!message.method) return undefined;
    if (message.id === undefined || message.id === null) return undefined;

    try {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: await dispatch(message.method, message.params)
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? boundedString(error.message, 240) : "unknown OpenCandle MCP server error"
        }
      };
    }
  }

  return { dispatch, handleMessage };
}

export function createOpenCandleProvider(env: Readonly<Record<string, string | undefined>>): FearGreedProvider {
  return {
    async getFearGreedIndex(): Promise<FearGreedData> {
      const opencandleRoot = env.OPENCANDLE_ROOT?.trim();
      if (!opencandleRoot) {
        throw new Error("OPENCANDLE_ROOT is required and must point to a local OpenCandle checkout.");
      }
      if (!isAbsolute(opencandleRoot)) {
        throw new Error("OPENCANDLE_ROOT must be an absolute path to a local OpenCandle checkout.");
      }
      const realOpenCandleRoot = realpathSync(opencandleRoot);
      if (!statSync(realOpenCandleRoot).isDirectory()) {
        throw new Error("OPENCANDLE_ROOT must resolve to an existing directory.");
      }

      const providerUrl = pathToFileURL(join(realOpenCandleRoot, "src/providers/fear-greed.ts")).href;
      const module = (await import(providerUrl)) as { getFearGreedIndex?: () => Promise<FearGreedData> };
      if (typeof module.getFearGreedIndex !== "function") {
        throw new Error("OpenCandle fear-greed provider export getFearGreedIndex was not found.");
      }
      return module.getFearGreedIndex();
    }
  };
}

export async function runStdioServer(options: OpenCandleMcpServerOptions = {}): Promise<void> {
  const server = createOpenCandleMcpServer(options);
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    void drainMessages();
  });

  async function drainMessages(): Promise<void> {
    while (buffer.length > 0) {
      const framed = readFramedMessage(buffer);
      if (framed.kind === "need-more") return;
      if (framed.kind === "message") {
        buffer = framed.remaining;
        await writeResponse(framed.message);
        continue;
      }

      const lineEnd = buffer.indexOf(0x0a);
      if (lineEnd === -1) return;
      const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
      buffer = buffer.subarray(lineEnd + 1);
      if (line) await writeResponse(JSON.parse(line) as RpcMessage);
    }
  }

  async function writeResponse(message: RpcMessage): Promise<void> {
    const response = await server.handleMessage(message);
    if (response) stdout.write(`${JSON.stringify(response)}\n`);
  }
}

function readFramedMessage(
  buffer: Buffer<ArrayBufferLike>
):
  | { kind: "message"; message: RpcMessage; remaining: Buffer<ArrayBufferLike> }
  | { kind: "need-more" }
  | { kind: "not-framed" } {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return { kind: "not-framed" };

  const header = buffer.subarray(0, headerEnd).toString("utf8");
  const match = /^Content-Length:\s*(\d+)$/im.exec(header);
  if (!match) return { kind: "not-framed" };

  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return { kind: "need-more" };

  return {
    kind: "message",
    message: JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as RpcMessage,
    remaining: buffer.subarray(bodyEnd)
  };
}

function boundedFearGreedData(data: FearGreedData): FearGreedData {
  if (!Number.isFinite(data.value) || data.value < 0 || data.value > 100) {
    throw new Error("OpenCandle fear-greed provider returned an invalid value.");
  }
  const value = Math.round(data.value);
  return {
    value,
    label: labelForFearGreedValue(value)
  };
}

function boundedString(value: string, maxLength: number): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 15))}...[truncated]`;
}

function labelForFearGreedValue(value: number): string {
  if (value <= 24) return "Extreme Fear";
  if (value <= 49) return "Fear";
  if (value <= 50) return "Neutral";
  if (value <= 74) return "Greed";
  return "Extreme Greed";
}

function readObject(value: JsonValue | undefined): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runStdioServer();
}
