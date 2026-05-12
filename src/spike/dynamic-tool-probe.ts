import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectProbe, printEventSummary, summarizeValue } from "./probe-utils.js";
import type { CodexWsClient, JsonObject, JsonValue } from "../codex/ws-client.js";

type SchemaProbe = {
  file: string;
  hasDynamicToolSpec: boolean;
  hasDynamicToolCall: boolean;
};

const schemaFiles = [
  "schemas/generated/ClientRequest.ts",
  "schemas/generated/InitializeParams.ts",
  "schemas/generated/InitializeCapabilities.ts",
  "schemas/generated/ServerRequest.ts",
  "schemas/generated/v2/TurnStartParams.ts",
  "schemas/generated/v2/PluginDetail.ts",
  "schemas/generated/v2/PluginInterface.ts",
  "schemas/generated/v2/AppSummary.ts",
  "schemas/generated/v2/Config.ts",
  "schemas/generated/v2/ProfileV2.ts"
] as const;

const dynamicToolFiles = [
  "schemas/generated/v2/DynamicToolSpec.ts",
  "schemas/generated/v2/DynamicToolCallParams.ts",
  "schemas/generated/v2/DynamicToolCallResponse.ts",
  "schemas/generated/v2/DynamicToolCallOutputContentItem.ts"
] as const;

const root = process.cwd();

const schemaProbes = await readSchemaProbes();
const dynamicToolPresence = await readDynamicToolPresence();

console.error("[probe] dynamic tool schema surface");
for (const probe of schemaProbes) {
  console.error(
    `  ${probe.file} DynamicToolSpec=${probe.hasDynamicToolSpec ? "yes" : "no"} item/tool/call=${
      probe.hasDynamicToolCall ? "yes" : "no"
    }`
  );
}
for (const [file, present] of Object.entries(dynamicToolPresence)) {
  console.error(`  ${file} present=${present ? "yes" : "no"}`);
}

const registrationEvidence = schemaProbes.filter(
  (probe) => probe.file !== "schemas/generated/ServerRequest.ts" && probe.hasDynamicToolSpec
);
if (registrationEvidence.length === 0) {
  console.error("[probe] generated_schema_registration_path=not_found");
} else {
  console.error(
    `[probe] generated_schema_registration_path=candidate files=${registrationEvidence
      .map((probe) => probe.file)
      .join(",")}`
  );
}

await probeConnection(false);
await probeConnection(true);

if (registrationEvidence.length === 0) {
  console.error("[probe] outcome=registration_unavailable_in_generated_client_schema");
  console.error("[probe] item/tool/call live observation skipped because no generated registration path was found");
} else {
  throw new Error("Generated registration candidates exist; extend this spike before claiming Phase 0 completion");
}

async function probeConnection(experimentalApi: boolean): Promise<void> {
  const { client, events } = await connectProbe({
    experimentalApi,
    clientName: experimentalApi ? "codexclaw-dynamic-tool-probe-experimental" : "codexclaw-dynamic-tool-probe",
    logInbound: false
  });

  try {
    await probeMethod(client, "experimentalFeature/list", { limit: 20 });
    await probeMethod(client, "plugin/list", {});
    await probeMethod(client, "app/list", { limit: 20 });
    await probeMethod(client, "config/read", { includeLayers: false });
    printEventSummary(events);
  } finally {
    client.close();
  }
}

async function probeMethod(client: CodexWsClient, method: string, params: JsonObject): Promise<void> {
  try {
    const response = await client.request(method, params);
    console.error(`[probe] method=${method} result=${summarizeShape(response)}`);
    console.error(`[probe] method=${method} dynamic_reference=${containsDynamicReference(response) ? "yes" : "no"}`);
  } catch (error) {
    console.error(`[probe] method=${method} error=${summarizeError(error)}`);
  }
}

async function readSchemaProbes(): Promise<SchemaProbe[]> {
  const probes: SchemaProbe[] = [];

  for (const file of schemaFiles) {
    const text = await readText(file);
    probes.push({
      file,
      hasDynamicToolSpec: /\bDynamicToolSpec\b/.test(text),
      hasDynamicToolCall: /item\/tool\/call/.test(text)
    });
  }

  return probes;
}

async function readDynamicToolPresence(): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const file of dynamicToolFiles) result[file] = (await readText(file)) !== "";
  return result;
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(join(root, file), "utf8");
  } catch {
    return "";
  }
}

function containsDynamicReference(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return /\bdynamic\s*tool\b|DynamicTool|item\/tool\/call/i.test(value);
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.some((item) => containsDynamicReference(item));

  return Object.entries(value).some(([key, child]) => /dynamicTool|dynamic_tool|item\/tool\/call/i.test(key) || containsDynamicReference(child));
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? `Error(${summarizeValue(error.message)})` : summarizeValue(error as JsonValue);
}

function summarizeShape(value: JsonValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length}${value[0] === undefined ? "" : `, item=${summarizeShape(value[0])}`})`;

  const type = typeof value;
  if (type === "string") return `string(len=${(value as string).length})`;
  if (type === "number" || type === "boolean") return type;
  if (type !== "object") return type;

  const entries = Object.entries(value);
  const sample = entries
    .slice(0, 8)
    .map(([, child]) => summarizeShape(child))
    .join(", ");
  const suffix = entries.length > 8 ? `, +${entries.length - 8}` : "";
  return `object(fields=${entries.length}${sample ? `, values=[${sample}${suffix}]` : ""})`;
}
