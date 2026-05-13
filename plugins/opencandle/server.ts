import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export interface OpenCandleAdapterServerOptions {
  env?: Readonly<Record<string, string | undefined>>;
}

export interface OpenCandleMcpServerModule {
  handleJsonRpcRequest?: (request: JsonObject) => Promise<JsonObject | undefined>;
}

export function resolveOpenCandleMcpServerPath(options: OpenCandleAdapterServerOptions = {}): string {
  const env = options.env ?? process.env;
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

  const serverPath = join(realOpenCandleRoot, "dist", "codexclaw", "mcp-server.js");
  try {
    if (!statSync(serverPath).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("OpenCandle MCP adapter was not found. Run `npm run build` in OPENCANDLE_ROOT first.");
  }
  return serverPath;
}

export async function loadOpenCandleMcpServerModule(
  options: OpenCandleAdapterServerOptions = {}
): Promise<Required<OpenCandleMcpServerModule>> {
  const serverPath = resolveOpenCandleMcpServerPath(options);
  const module = (await import(pathToFileURL(serverPath).href)) as OpenCandleMcpServerModule;
  if (typeof module.handleJsonRpcRequest !== "function") {
    throw new Error("OpenCandle MCP adapter export handleJsonRpcRequest was not found.");
  }
  return { handleJsonRpcRequest: module.handleJsonRpcRequest };
}

export async function runDelegatedOpenCandleMcpServer(options: OpenCandleAdapterServerOptions = {}): Promise<void> {
  const module = await loadOpenCandleMcpServerModule(options);
  runLineDelimitedJsonRpcServer(module);
}

function runLineDelimitedJsonRpcServer(module: Required<OpenCandleMcpServerModule>): void {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const timer = setInterval(() => undefined, 2 ** 30);
  const clear = () => clearInterval(timer);

  stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    void drainMessages();
  });
  stdin.once("end", clear);
  stdin.once("close", clear);
  stdin.resume();

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
      if (line) await writeResponse(JSON.parse(line) as JsonObject);
    }
  }

  async function writeResponse(message: JsonObject): Promise<void> {
    const response = await module.handleJsonRpcRequest(message);
    if (response) stdout.write(`${JSON.stringify(response)}\n`);
  }
}

function readFramedMessage(
  buffer: Buffer<ArrayBufferLike>
):
  | { kind: "message"; message: JsonObject; remaining: Buffer<ArrayBufferLike> }
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
    message: JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as JsonObject,
    remaining: buffer.subarray(bodyEnd),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runDelegatedOpenCandleMcpServer();
}
