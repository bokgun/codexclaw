import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validatePluginDescriptor } from "../src/plugins/validation.js";

const root = process.cwd();
const outputPath = resolve(root, process.env.CODEXCLAW_OPENCANDLE_PLUGIN_DESCRIPTOR ?? "local-plugins/opencandle/codexclaw-plugin.json");
const templatePath = resolve(root, "plugins/opencandle/codexclaw-plugin.template.json");
const serverPath = resolve(root, "plugins/opencandle/server.ts");

const descriptorText = readFileSync(templatePath, "utf8")
  .replaceAll("__CODEXCLAW_BUN_COMMAND__", process.execPath)
  .replaceAll("__CODEXCLAW_OPENCANDLE_SERVER__", serverPath);
const descriptor = JSON.parse(descriptorText) as unknown;
const result = validatePluginDescriptor(descriptor);
if (!result.ok) {
  const diagnostics = result.diagnostics.map((item) => `${item.path} ${item.code}: ${item.message}`).join("\n");
  throw new Error(`Generated OpenCandle plugin descriptor is invalid:\n${diagnostics}`);
}

mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });

console.log(`Wrote OpenCandle plugin descriptor: ${outputPath}`);
console.log(`Set CODEXCLAW_PLUGIN_DIRS=${dirname(dirname(outputPath))}`);
