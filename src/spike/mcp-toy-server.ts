import { stdin, stdout } from "node:process";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type RpcMessage = {
  id?: number | string | null;
  method?: string;
  params?: JsonValue;
};

const serverInfo = {
  name: "codexclaw-mcp-toy",
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

  try {
    respond(message.id, dispatch(message.method, message.params));
  } catch (error) {
    respondError(message.id, {
      code: -32000,
      message: error instanceof Error ? error.message : "unknown MCP toy server error"
    });
  }
}

function dispatch(method: string, params: JsonValue | undefined): JsonValue {
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
          name: "codexclaw_echo_shape",
          title: "Codexclaw Echo Shape",
          description: "Returns bounded metadata derived from a short label.",
          inputSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
                minLength: 1,
                maxLength: 32
              }
            },
            required: ["label"],
            additionalProperties: false
          }
        }
      ]
    };
  }

  if (method === "tools/call") {
    const object = readObject(params);
    if (object?.name !== "codexclaw_echo_shape") throw new Error("unknown toy tool");

    const args = readObject(object.arguments);
    const label = args?.label;
    if (typeof label !== "string" || label.length < 1 || label.length > 32) {
      throw new Error("label must be a 1-32 character string");
    }

    return {
      content: [
        {
          type: "text",
          text: `codexclaw toy label length ${label.length}`
        }
      ],
      structuredContent: {
        labelLength: label.length,
        uppercaseAscii: /^[A-Z0-9_-]+$/.test(label)
      },
      isError: false
    };
  }

  if (method === "resources/list") return { resources: [] };
  if (method === "prompts/list") return { prompts: [] };

  throw new Error(`unsupported method ${method}`);
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
