import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginConfig } from "../../src/config/env.js";
import {
  createPluginCommandService,
  discoverLocalPluginRegistry,
  projectAppServerMcpConfig,
  validatePluginDescriptor
} from "../../src/plugins/index.js";
import { PointerStore } from "../../src/store/pointer-store.js";
import { loadOpenCandleMcpServerModule, resolveOpenCandleMcpServerPath } from "../../plugins/opencandle/server.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const pluginRoot = join(repoRoot, "plugins");
const templatePath = join(pluginRoot, "opencandle", "codexclaw-plugin.template.json");
const wrapperServerPath = join(pluginRoot, "opencandle", "server.ts");
const serverPath = wrapperServerPath;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCandle production plugin", () => {
  test("keeps the checked-in template non-discoverable", () => {
    const registry = discoverLocalPluginRegistry({ config: pluginConfig(pluginRoot), env: {} });

    expect(registry.entries.find((entry) => entry.id === "opencandle")).toBeUndefined();
    expect(existsSync(templatePath)).toBe(true);
    expect(existsSync(join(pluginRoot, "opencandle", "codexclaw-plugin.json"))).toBe(false);
  });

  test("materializes a valid descriptor without env values or user-specific paths", async () => {
    const descriptorPath = join(tempRoot(), "opencandle", "codexclaw-plugin.json");
    await materializeDescriptor(descriptorPath);
    const raw = readFileSync(descriptorPath, "utf8");
    const descriptor = JSON.parse(raw) as unknown;
    const result = validatePluginDescriptor(descriptor);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected OpenCandle descriptor to validate");

    expect(result.descriptor).toMatchObject({
      id: "opencandle",
      version: "0.2.0",
      mcp: {
        serverName: "opencandle",
        command: process.execPath,
        args: [serverPath],
        env: [{ name: "OPENCANDLE_ROOT", required: true }]
      },
      tools: [{ name: "get_stock_quote" }, { name: "search_ticker" }, { name: "get_fear_greed" }],
      security: {
        network: "declared",
        providers: ["OpenCandle", "Yahoo Finance", "Alternative.me"],
        envAllowlist: ["OPENCANDLE_ROOT"],
        elicitation: "fail_closed"
      }
    });
    expect(raw).not.toContain("__CODEXCLAW_");
    expect(raw).not.toContain("/Users/bokgun/Workspace/OpenCandle");
    expect(raw).not.toContain("/tmp/opencandle");
    expect(JSON.stringify(result.summary)).not.toContain(serverPath);
  });

  test("registry discovers materialized OpenCandle and projection keeps disabled or missing-env plugins out", async () => {
    const root = tempRoot();
    await materializeDescriptor(join(root, "opencandle", "codexclaw-plugin.json"));
    const store = new PointerStore();
    try {
      const disabled = discoverLocalPluginRegistry({ config: pluginConfig(root), store, env: {} });
      expect(disabled.entries.map((entry) => entry.id)).toContain("opencandle");
      const entry = disabled.entries.find((item) => item.id === "opencandle");
      expect(entry).toMatchObject({ enabled: false, status: "available" });
      expect(projectAppServerMcpConfig(disabled.entries, {}).mcpServers.find((server) => server.serverName === "opencandle")).toBeUndefined();

      store.setPluginEnablement({ pluginId: "opencandle", version: "0.2.0", enabled: true });
      const missing = discoverLocalPluginRegistry({ config: pluginConfig(root), store, env: {} });
      const missingEntry = missing.entries.find((item) => item.id === "opencandle");
      expect(missingEntry).toMatchObject({ enabled: true, status: "missing_env", missingEnvNames: ["OPENCANDLE_ROOT"] });
      expect(projectAppServerMcpConfig(missing.entries, {}).omitted).toContainEqual(
        expect.objectContaining({ pluginId: "opencandle", reason: "missing_env", missingEnvNames: ["OPENCANDLE_ROOT"] })
      );
    } finally {
      store.close();
    }
  });

  test("enabled projection forwards only the allowlisted OPENCANDLE_ROOT env", async () => {
    const root = tempRoot();
    await materializeDescriptor(join(root, "opencandle", "codexclaw-plugin.json"));
    const store = new PointerStore();
    try {
      store.setPluginEnablement({ pluginId: "opencandle", version: "0.2.0", enabled: true });
      const env = { OPENCANDLE_ROOT: "/fixture/opencandle", NOT_ALLOWLISTED: "secret" };
      const registry = discoverLocalPluginRegistry({ config: pluginConfig(root), store, env });
      const projection = projectAppServerMcpConfig(registry.entries, env);

      expect(projection.mcpServers).toContainEqual({
        serverName: "opencandle",
        command: process.execPath,
        args: [serverPath],
        env: [{ name: "OPENCANDLE_ROOT", value: "/fixture/opencandle" }]
      });
      expect(JSON.stringify(projection)).not.toContain("NOT_ALLOWLISTED");
      expect(JSON.stringify(projection)).not.toContain("secret");
    } finally {
      store.close();
    }
  });

  test("/plugin status shows provider and env names without env values or raw command args", async () => {
    const root = tempRoot();
    await materializeDescriptor(join(root, "opencandle", "codexclaw-plugin.json"));
    const store = new PointerStore();
    try {
      store.setPluginEnablement({ pluginId: "opencandle", version: "0.2.0", enabled: true });
      const service = createPluginCommandService({
        pluginConfig: pluginConfig(root),
        store,
        env: { OPENCANDLE_ROOT: "/fixture/opencandle" }
      });

      const status = await service.status("opencandle");
      expect(status).toContain("Network: declared");
      expect(status).toContain("Providers: OpenCandle, Yahoo Finance, Alternative.me");
      expect(status).toContain("Env names: OPENCANDLE_ROOT");
      expect(status).toContain("get_stock_quote");
      expect(status).toContain("search_ticker");
      expect(status).toContain("get_fear_greed");
      expect(status).not.toContain("/fixture/opencandle");
      expect(status).not.toContain(wrapperServerPath);
      expect(status).not.toContain(process.execPath);
    } finally {
      store.close();
    }
  });

  test("delegated server resolves the built OpenCandle MCP adapter", async () => {
    const opencandleRoot = tempRoot();
    const adapterDir = join(opencandleRoot, "dist", "codexclaw");
    mkdirSync(adapterDir, { recursive: true });
    writeFileSync(
      join(adapterDir, "mcp-server.js"),
      "export async function handleJsonRpcRequest() {}\n",
      "utf8"
    );

    expect(resolveOpenCandleMcpServerPath({ env: { OPENCANDLE_ROOT: opencandleRoot } })).toBe(
      join(realpathSync(opencandleRoot), "dist", "codexclaw", "mcp-server.js")
    );
    await expect(loadOpenCandleMcpServerModule({ env: { OPENCANDLE_ROOT: opencandleRoot } })).resolves.toEqual({
      handleJsonRpcRequest: expect.any(Function)
    });
  });

  test("delegated server rejects missing, relative, or unbuilt OPENCANDLE_ROOT with no hard-coded fallback", async () => {
    const source = readFileSync(wrapperServerPath, "utf8");
    expect(source).not.toContain("/Users/bokgun/Workspace/OpenCandle");

    expect(() => resolveOpenCandleMcpServerPath({ env: {} })).toThrow(
      "OPENCANDLE_ROOT is required and must point to a local OpenCandle checkout."
    );
    expect(() => resolveOpenCandleMcpServerPath({ env: { OPENCANDLE_ROOT: "relative/opencandle" } })).toThrow(
      "OPENCANDLE_ROOT must be an absolute path to a local OpenCandle checkout."
    );
    expect(() => resolveOpenCandleMcpServerPath({ env: { OPENCANDLE_ROOT: tempRoot() } })).toThrow(
      "OpenCandle MCP adapter was not found. Run `npm run build` in OPENCANDLE_ROOT first."
    );
  });
});

async function materializeDescriptor(outputPath: string): Promise<void> {
  const { exitCode, stderr } = await runMaterialize(outputPath);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
}

function runMaterialize(outputPath: string): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/materialize-opencandle-plugin.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEXCLAW_OPENCANDLE_PLUGIN_DESCRIPTOR: outputPath
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve({ exitCode, stderr }));
  });
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codexclaw-opencandle-plugin-test-"));
  roots.push(root);
  return root;
}

function pluginConfig(pluginDir: string): PluginConfig {
  return {
    pluginDirs: [pluginDir],
    maxDescriptorBytes: 64 * 1024,
    workspaceRoot: dirname(pluginDir),
    deniedRoots: []
  };
}
