import { CodexWsClient, JsonObject } from "../codex/ws-client.js";
import { textInput } from "../codex/input.js";
import { getCodexConnectionConfig } from "../config/env.js";

const { wsUrl, tokenFile } = getCodexConnectionConfig();

const client = new CodexWsClient({ url: wsUrl, tokenFile });

client.onNotification((event) => {
  console.error(`[event] ${event.method} ${event.params ? JSON.stringify(event.params) : ""}`);
});

await client.connect();

const thread = (await client.request("thread/start", {})) as JsonObject;
const threadId = readThreadId(thread);

if (!threadId) {
  throw new Error(`Unable to read thread id from thread/start response: ${JSON.stringify(thread)}`);
}

await client.request("turn/start", {
  threadId,
  input: [
    textInput(
      "Approval spike: propose a shell command, a file edit, and a network access that should require approval. Wait for approval when the runtime asks for it."
    )
  ]
});

client.close();

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
