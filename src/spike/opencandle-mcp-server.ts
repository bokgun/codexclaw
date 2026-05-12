import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type RpcMessage = {
  id?: number | string | null;
  method?: string;
  params?: JsonValue;
};

type FearGreedData = {
  value: number;
  label: string;
  timestamp: number;
  previousClose: number;
  weekAgo: number | null;
  monthAgo: number | null;
};

const serverInfo = {
  name: "codexclaw-opencandle-mcp",
  version: "0.0.0"
};

let buffer = Buffer.alloc(0);

stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  drainMessages();
});

function drainMessages(): void {
  while (buffer.length > 0) {
    const framed = readFramedMessage();
    if (framed === "need-more") return;
    if (framed) {
      handleMessage(framed);
      continue;
    }

    const lineEnd = buffer.indexOf(0x0a);
    if (lineEnd === -1) return;
    const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
    buffer = buffer.subarray(lineEnd + 1);
    if (line) handleMessage(JSON.parse(line) as RpcMessage);
  }
}

function readFramedMessage(): RpcMessage | "need-more" | undefined {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return undefined;

  const header = buffer.subarray(0, headerEnd).toString("utf8");
  const match = /^Content-Length:\s*(\d+)$/im.exec(header);
  if (!match) return undefined;

  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return "need-more";

  const raw = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
  buffer = buffer.subarray(bodyEnd);
  return JSON.parse(raw) as RpcMessage;
}

function handleMessage(message: RpcMessage): void {
  if (!message.method) return;
  if (message.id === undefined || message.id === null) return;

  dispatch(message.method, message.params).then(
    (result) => respond(message.id as number | string, result),
    (error) => {
      respondError(message.id as number | string, {
        code: -32000,
        message: error instanceof Error ? error.message : "unknown OpenCandle MCP server error"
      });
    }
  );
}

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
      tools: [
        {
          name: "get_fear_greed",
          title: "OpenCandle Fear And Greed",
          description: "Fetches OpenCandle's crypto Fear and Greed index provider.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false
          }
        }
      ]
    };
  }

  if (method === "tools/call") {
    const object = readObject(params);
    if (object?.name !== "get_fear_greed") throw new Error("unknown OpenCandle tool");

    const args = readObject(object.arguments) ?? {};
    if (Object.keys(args).length > 0) throw new Error("get_fear_greed does not accept arguments");

    const quote = await readFearGreedIndex();
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
        source: "alternative.me",
        previousClose: quote.previousClose
      },
      isError: false
    };
  }

  if (method === "resources/list") return { resources: [] };
  if (method === "prompts/list") return { prompts: [] };

  throw new Error(`unsupported method ${method}`);
}

async function readFearGreedIndex(): Promise<FearGreedData> {
  const opencandleRoot = process.env.OPENCANDLE_ROOT ?? "/Users/bokgun/Workspace/OpenCandle";
  const providerUrl = pathToFileURL(join(opencandleRoot, "src/providers/fear-greed.ts")).href;
  const module = (await import(providerUrl)) as { getFearGreedIndex: () => Promise<FearGreedData> };
  return module.getFearGreedIndex();
}

function respond(id: number | string, result: JsonValue): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id: number | string, error: JsonObject): void {
  writeMessage({ jsonrpc: "2.0", id, error });
}

function writeMessage(message: JsonObject): void {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function readObject(value: JsonValue | undefined): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}
