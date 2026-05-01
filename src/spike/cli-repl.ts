import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CodexWsClient, JsonObject } from "../codex/ws-client.js";
import { getCodexConnectionConfig } from "../config/env.js";
import { readThreadId, startTurn, summarizeValue } from "./probe-utils.js";

const { wsUrl, tokenFile } = getCodexConnectionConfig();

const client = new CodexWsClient({ url: wsUrl, tokenFile });
let threadId: string | undefined;

client.onNotification((event) => {
  if (event.method.includes("delta") && event.params) {
    const params = event.params as JsonObject;
    if (typeof params.delta === "string") process.stdout.write(params.delta);
    else console.error(`\n[event] ${event.method} ${summarizeValue(event.params)}`);
    return;
  }

  console.error(`\n[event] ${event.method} ${summarizeValue(event.params)}`);
});

client.onServerRequest((request) => {
  console.error(`\n[server request] id=${request.id} method=${request.method} params=${summarizeValue(request.params)}`);
});

await client.connect();
console.error(`connected: ${wsUrl}`);

const thread = (await client.request("thread/start", {})) as JsonObject;
threadId = readThreadId(thread);

if (!threadId) {
  throw new Error(`Unable to read thread id from thread/start response shape: ${summarizeValue(thread)}`);
}

console.error(`thread: ${threadId}`);

const repl = createInterface({ input, output });

try {
  for (;;) {
    const prompt = await readPrompt(repl);
    if (prompt === undefined) break;
    if (prompt.trim() === "/quit") break;
    if (!prompt.trim()) continue;

    try {
      await startTurn(client, threadId, prompt);
    } catch (error) {
      console.error(`\n[request error] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  repl.close();
  client.close();
}

async function readPrompt(repl: ReturnType<typeof createInterface>): Promise<string | undefined> {
  try {
    return await repl.question("\ncodexclaw> ");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ERR_USE_AFTER_CLOSE") {
      return undefined;
    }
    throw error;
  }
}
