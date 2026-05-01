import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CodexWsClient, JsonObject } from "../codex/ws-client.js";
import { textInput } from "../codex/input.js";
import { getCodexConnectionConfig } from "../config/env.js";

const { wsUrl, tokenFile } = getCodexConnectionConfig();

const client = new CodexWsClient({ url: wsUrl, tokenFile });
let threadId: string | undefined;

client.onNotification((event) => {
  if (event.method.includes("delta") && event.params) {
    const params = event.params as JsonObject;
    const text = typeof params.delta === "string" ? params.delta : JSON.stringify(params);
    process.stdout.write(text);
    return;
  }

  console.error(`\n[event] ${event.method} ${event.params ? JSON.stringify(event.params) : ""}`);
});

await client.connect();
console.error(`connected: ${wsUrl}`);

const thread = (await client.request("thread/start", {})) as JsonObject;
threadId = readThreadId(thread);

if (!threadId) {
  throw new Error(`Unable to read thread id from thread/start response: ${JSON.stringify(thread)}`);
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
      await client.request("turn/start", {
        threadId,
        input: [textInput(prompt)]
      });
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

function readThreadId(response: JsonObject): string | undefined {
  if (typeof response.thread_id === "string") return response.thread_id;
  if (typeof response.threadId === "string") return response.threadId;

  const thread = response.thread;
  if (thread && typeof thread === "object" && !Array.isArray(thread)) {
    const id = (thread as JsonObject).id;
    if (typeof id === "string") return id;
  }

  return undefined;
}
