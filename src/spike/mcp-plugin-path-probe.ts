import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { startThread, startTurn, summarizeValue } from "./probe-utils.js";
import { CodexWsClient, type JsonObject, type JsonValue, type RpcInbound } from "../codex/ws-client.js";

type ProbeObservation = {
  method: string;
  status: "success" | "error" | "skipped";
  shapeSummary: string;
  rawPayloadPersisted: false;
};

type ProbeTarget = {
  id: string;
  serverName: string;
  serverInfoName: string;
  toolName: string;
  serverPath: string;
  directArguments: JsonObject;
  malformedArguments: JsonObject;
  turnPrompt: string;
  requiresNetworkProvider: boolean;
};

const root = process.cwd();
const target = selectTarget();
const runTurnProbe = process.env.CODEXCLAW_MCP_PROBE_TURN === "1";
const copyAuth = process.env.CODEXCLAW_MCP_PROBE_COPY_AUTH === "1";
const codexCommand = process.env.CODEXCLAW_MCP_PROBE_CODEX ?? "codex";
const bunCommand = process.execPath;

const observations: ProbeObservation[] = [];

console.error("[probe] mcp schema provenance");
console.error("  active_root=schemas/generated");
console.error("  nested_v2_imported_by_active_client_request=yes");
console.error("  schema_gate_required=bun run schema:verify");
console.error("  raw_payload_persistence=false");
console.error("  direct_tool_call_scope=probe_only_non_production");
console.error(`  target=${target.id}`);
console.error(`  network_provider=${target.requiresNetworkProvider ? "yes" : "no"}`);
console.error(`  auth_copied_to_temp_codex_home=${copyAuth ? "yes" : "no"}`);

const appServer = await startIsolatedAppServer();

try {
  const { client, events } = await connectIsolated(appServer.wsUrl, appServer.tokenFile, "codexclaw-mcp-plugin-path-probe");

  try {
    client.onServerRequest((request) => {
      if (request.method === "mcpServer/elicitation/request") {
        observations.push({
          method: request.method,
          status: "skipped",
          shapeSummary: `server_request ${summarizeMcpPayload(request.params)} fail_closed_decline`,
          rawPayloadPersisted: false
        });
        client.respond(request.id, { action: "decline", content: null, _meta: null });
        return;
      }

      observations.push({
        method: request.method,
        status: "skipped",
        shapeSummary: "server_request fail_closed_unsupported",
        rawPayloadPersisted: false
      });
      client.respondError(request.id, { code: -32601, message: "Unsupported server request method" });
    });

    await probeMethod(client, "config/mcpServer/reload", undefined);
    await delay(1_000);

    const status = await probeMethod(client, "mcpServerStatus/list", { detail: "full", limit: 20 });
    const targetReady = isTargetServerReady(status);
    console.error(`[probe] target_server_ready=${targetReady ? "yes" : "no"}`);

    let threadId: string | undefined;
    try {
      threadId = await startThread(client, { cwd: root, ephemeral: true });
      observations.push({
        method: "thread/start",
        status: "success",
        shapeSummary: "thread_id=present",
        rawPayloadPersisted: false
      });
    } catch (error) {
      observations.push({
        method: "thread/start",
        status: "error",
        shapeSummary: summarizeError(error),
        rawPayloadPersisted: false
      });
    }

    await probeFailureCases(client, threadId);

    if (targetReady && threadId) {
      await probeMethod(client, "mcpServer/tool/call", {
        threadId,
        server: target.serverName,
        tool: target.toolName,
        arguments: target.directArguments
      });
    } else {
      observations.push({
        method: "mcpServer/tool/call",
        status: "skipped",
        shapeSummary: `targetReady=${targetReady ? "yes" : "no"} threadId=${threadId ? "present" : "missing"}`,
        rawPayloadPersisted: false
      });
    }

    if (runTurnProbe && targetReady && threadId) {
      const startIndex = events.mark();
      await startTurn(client, threadId, target.turnPrompt);
      const terminal = await events.waitForTurnTerminal(Number(process.env.CODEXCLAW_PROBE_TIMEOUT_MS ?? 120_000), startIndex);
      const mcpEvents = events.countMcpEvents(startIndex);
      observations.push({
        method: "turn/start:mcp",
        status: terminal && mcpEvents > 0 ? "success" : "error",
        shapeSummary: `terminal=${terminal ?? "timeout"} mcp_events=${mcpEvents}`,
        rawPayloadPersisted: false
      });
    } else {
      observations.push({
        method: "turn/start:mcp",
        status: "skipped",
        shapeSummary: `enabled=${runTurnProbe ? "yes" : "no"} targetReady=${targetReady ? "yes" : "no"} auth_copied=${copyAuth ? "yes" : "no"}`,
        rawPayloadPersisted: false
      });
    }

    printObservations();
    events.printSummary();
  } finally {
    client.close();
  }
} finally {
  await stopProcess(appServer.process);
  await rm(appServer.home, { force: true, recursive: true });
  await rm(appServer.stateDir, { force: true, recursive: true });
}

async function probeMethod(client: CodexWsClient, method: string, params: JsonObject | undefined): Promise<JsonValue | undefined> {
  try {
    const response = await client.request(method, params);
    const summary = summarizeProbeResponse(method, response);
    observations.push({
      method,
      status: "success",
      shapeSummary: summary,
      rawPayloadPersisted: false
    });
    console.error(`[probe] method=${method} status=success shape=${summary}`);
    return response;
  } catch (error) {
    const summary = summarizeError(error);
    observations.push({
      method,
      status: "error",
      shapeSummary: summary,
      rawPayloadPersisted: false
    });
    console.error(`[probe] method=${method} status=error shape=${summary}`);
    return undefined;
  }
}

function summarizeProbeResponse(method: string, value: JsonValue | undefined): string {
  if (method.includes("mcpServer")) return summarizeMcpPayload(value);
  return summarizeValue(value);
}

function summarizeMcpPayload(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length})`;

  const type = typeof value;
  if (type === "string") return `string(len=${(value as string).length})`;
  if (type === "number" || type === "boolean") return type;
  if (type !== "object") return type;

  const object = value as JsonObject;
  const keys = new Set(Object.keys(object));
  const known = [
    "data",
    "nextCursor",
    "content",
    "structuredContent",
    "isError",
    "tools",
    "resources",
    "resourceTemplates",
    "authStatus"
  ].filter((key) => keys.has(key));
  return `object(fields=${keys.size}${known.length > 0 ? `, known=${known.join("|")}` : ""})`;
}

async function probeFailureCases(client: CodexWsClient, threadId: string | undefined): Promise<void> {
  if (!threadId) {
    for (const method of ["unknown_server", "unknown_tool", "malformed_arguments"]) {
      observations.push({
        method: `mcpServer/tool/call:${method}`,
        status: "skipped",
        shapeSummary: "thread_id=missing",
        rawPayloadPersisted: false
      });
    }
    return;
  }

  await probeMethod(client, "mcpServer/tool/call", {
    threadId,
    server: "codexclaw-missing",
    tool: target.toolName
  });
  await probeMethod(client, "mcpServer/tool/call", {
    threadId,
    server: target.serverName,
    tool: "codexclaw_missing_tool"
  });
  await probeMethod(client, "mcpServer/tool/call", {
    threadId,
    server: target.serverName,
    tool: target.toolName,
    arguments: target.malformedArguments
  });
}

function isTargetServerReady(value: JsonValue | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = (value as JsonObject).data;
  if (!Array.isArray(data)) return false;

  return data.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const status = item as JsonObject;
    if (status.name !== target.serverName) return false;
    const tools = status.tools;
    return !!tools && typeof tools === "object" && !Array.isArray(tools) && target.toolName in tools;
  });
}

async function startIsolatedAppServer(): Promise<{
  home: string;
  stateDir: string;
  tokenFile: string;
  wsUrl: string;
  process: ChildProcessWithoutNullStreams;
}> {
  const home = await mkdtemp(join(tmpdir(), "codexclaw-mcp-home-"));
  const stateDir = await mkdtemp(join(tmpdir(), "codexclaw-mcp-state-"));
  let child: ChildProcessWithoutNullStreams | undefined;

  try {
    const codexDir = join(home, ".codex");
    await mkdir(codexDir, { recursive: true, mode: 0o700 });

    const tokenFile = join(stateDir, "codex.token");
    await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    if (copyAuth) await copyCodexAuth(codexDir);

    await writeFile(
      join(codexDir, "config.toml"),
      [
        `[mcp_servers.${target.serverName}]`,
        `command = ${tomlString(bunCommand)}`,
        `args = [${tomlString(target.serverPath)}]`,
        ""
      ].join("\n"),
      { mode: 0o600 }
    );

    const port = await getFreePort();
    const wsUrl = `ws://127.0.0.1:${port}`;
    child = spawn(
      codexCommand,
      ["app-server", "--listen", wsUrl, "--ws-auth", "capability-token", "--ws-token-file", tokenFile],
      {
        cwd: root,
        env: isolatedAppServerEnv(home, codexDir, stateDir)
      }
    );

    const appServerLogCounts = { stdout: 0, stderr: 0 };
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) appServerLogCounts.stderr += 1;
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) appServerLogCounts.stdout += 1;
      }
    });

    await waitForPortOrExit(wsUrl, tokenFile, child);
    console.error(`[probe] app_server_logs stdout_lines=${appServerLogCounts.stdout} stderr_lines=${appServerLogCounts.stderr}`);
    return { home, stateDir, tokenFile, wsUrl, process: child };
  } catch (error) {
    if (child) await stopProcess(child);
    await rm(home, { force: true, recursive: true });
    await rm(stateDir, { force: true, recursive: true });
    throw error;
  }
}

async function copyCodexAuth(codexDir: string): Promise<void> {
  const sourceCodexHome = process.env.CODEXCLAW_MCP_PROBE_AUTH_CODEX_HOME
    ?? process.env.CODEX_HOME
    ?? (process.env.HOME ? join(process.env.HOME, ".codex") : undefined);
  if (!sourceCodexHome) throw new Error("CODEXCLAW_MCP_PROBE_COPY_AUTH requires HOME, CODEX_HOME, or CODEXCLAW_MCP_PROBE_AUTH_CODEX_HOME");

  const authTarget = join(codexDir, "auth.json");
  await copyFile(join(sourceCodexHome, "auth.json"), authTarget);
  await chmod(authTarget, 0o600);
}

function isolatedAppServerEnv(home: string, codexDir: string, stateDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    CODEX_HOME: codexDir,
    TMPDIR: stateDir,
    PATH: process.env.PATH ?? "",
    USER: process.env.USER ?? "codexclaw",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "codexclaw",
    SHELL: process.env.SHELL ?? "/bin/zsh"
  };

  const term = process.env.TERM;
  if (term) env.TERM = term;
  const opencandleRoot = process.env.OPENCANDLE_ROOT;
  if (opencandleRoot) env.OPENCANDLE_ROOT = opencandleRoot;
  return env;
}

async function waitForPort(wsUrl: string, tokenFile: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const { client } = await connectIsolated(wsUrl, tokenFile, "codexclaw-mcp-plugin-path-wait");
      client.close();
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw new Error(`Timed out waiting for isolated app-server: ${summarizeError(lastError)}`);
}

function waitForPortOrExit(
  wsUrl: string,
  tokenFile: string,
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Isolated app-server exited before ready: code=${code ?? "null"} signal=${signal ?? "null"}`));
    };

    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }

    waitForPort(wsUrl, tokenFile).then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  if (await waitForExit(child, 1_000)) return;

  child.kill("SIGKILL");
  await waitForExit(child, 5_000);
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };

    child.once("exit", onExit);
  });
}

async function connectIsolated(
  wsUrl: string,
  tokenFile: string,
  clientName: string
): Promise<{ client: CodexWsClient; events: ProbeEventRecorder }> {
  const client = new CodexWsClient({
    url: wsUrl,
    tokenFile,
    clientName
  });
  const events = new ProbeEventRecorder();
  client.onInbound((message) => events.record(message));
  await client.connect();
  console.error(`[probe] connected url=${wsUrl} client=${clientName}`);
  return { client, events };
}

class ProbeEventRecorder {
  private sequence = 0;
  private readonly counts = new Map<string, number>();
  private readonly terminalTurns: Array<{ index: number; method: string }> = [];
  private readonly mcpEventIndexes: number[] = [];

  record(message: RpcInbound): void {
    const index = this.sequence++;
    const key = message.kind === "response" ? `response:${message.id}` : `${message.kind}:${message.method}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);

    if (message.kind !== "notification") return;
    if (message.method === "turn/completed") this.terminalTurns.push({ index, method: message.method });
    if (isMcpNotification(message)) this.mcpEventIndexes.push(index);
  }

  mark(): number {
    return this.sequence;
  }

  async waitForTurnTerminal(timeoutMs: number, startIndex: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const terminal = this.terminalTurns.find((event) => event.index >= startIndex);
      if (terminal) return terminal.method;
      await delay(250);
    }

    return undefined;
  }

  countMcpEvents(startIndex: number): number {
    return this.mcpEventIndexes.filter((index) => index >= startIndex).length;
  }

  printSummary(): void {
    console.error("[probe] event counts");
    for (const [key, count] of [...this.counts.entries()].sort()) {
      console.error(`  ${key} ${count}`);
    }
  }
}

function isMcpNotification(event: Extract<RpcInbound, { kind: "notification" }>): boolean {
  if (event.method === "item/mcpToolCall/progress") return true;
  if (event.method !== "item/started" && event.method !== "item/completed") return false;
  const params = event.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const item = (params as JsonObject).item;
  return !!item && typeof item === "object" && !Array.isArray(item) && (item as JsonObject).type === "mcpToolCall";
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else reject(new Error("Unable to allocate loopback port"));
      });
    });
    server.on("error", reject);
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) return `Error(${summarizeValue(error.message)})`;
  return summarizeValue(error as JsonValue);
}

function printObservations(): void {
  console.error("[probe] observations");
  for (const observation of observations) {
    console.error(
      `  method=${observation.method} status=${observation.status} shape=${observation.shapeSummary} rawPayloadPersisted=${observation.rawPayloadPersisted}`
    );
  }
}

function selectTarget(): ProbeTarget {
  const id = process.env.CODEXCLAW_MCP_PROBE_TARGET ?? "toy";
  if (id === "toy") {
    return {
      id,
      serverName: "codexclaw-toy",
      serverInfoName: "codexclaw-mcp-toy",
      toolName: "codexclaw_echo_shape",
      serverPath: resolve(root, "src/spike/mcp-toy-server.ts"),
      directArguments: { label: "MCP_PATH_SPIKE" },
      malformedArguments: { label: "" },
      turnPrompt:
        "Use the MCP toy tool named codexclaw_echo_shape on server codexclaw-toy with the label MCP_TURN_SPIKE, then answer with only whether the MCP tool call succeeded.",
      requiresNetworkProvider: false
    };
  }

  if (id === "opencandle") {
    return {
      id,
      serverName: "opencandle",
      serverInfoName: "codexclaw-opencandle-mcp",
      toolName: "get_fear_greed",
      serverPath: resolve(root, "plugins/opencandle/server.ts"),
      directArguments: {},
      malformedArguments: { unexpected: true },
      turnPrompt:
        "Use the MCP tool get_fear_greed on server opencandle to fetch the current crypto Fear and Greed index, then summarize only whether the MCP tool call succeeded and the returned classification.",
      requiresNetworkProvider: true
    };
  }

  throw new Error(`Unsupported CODEXCLAW_MCP_PROBE_TARGET: ${id}`);
}
