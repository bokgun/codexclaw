import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../../src/config/env.js";
import {
  discoverLocalPluginRegistry,
  projectAppServerMcpConfig,
  type PluginDescriptorV1
} from "../../src/plugins/index.js";
import { PointerStore } from "../../src/store/pointer-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local plugin registry", () => {
  test("empty plugin config returns an empty registry and projection", () => {
    const registry = discoverLocalPluginRegistry({ config: pluginConfig([]) });

    expect(registry.entries).toEqual([]);
    expect(registry.diagnostics).toEqual([]);
    expect(projectAppServerMcpConfig(registry.entries)).toEqual({ mcpServers: [], omitted: [] });
  });

  test("discovers a valid descriptor disabled by default", () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor());

    const registry = discoverLocalPluginRegistry({ config: pluginConfig([root]) });
    const projection = projectAppServerMcpConfig(registry.entries, { OPENCANDLE_ROOT: "/tmp/opencandle" });

    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]).toMatchObject({
      id: "opencandle",
      enabled: false,
      status: "available",
      sourceLabel: root.split("/").at(-1)
    });
    expect(registry.entries[0].sourceLabel).not.toContain("/Users/");
    expect(projection.mcpServers).toEqual([]);
    expect(projection.omitted).toMatchObject([{ pluginId: "opencandle", reason: "disabled" }]);
  });

  test("continues after invalid JSON and invalid descriptors with bounded diagnostics", () => {
    const root = tempRoot();
    mkdirSync(join(root, "bad-json"));
    mkdirSync(join(root, "bad-descriptor"));
    mkdirSync(join(root, "good"));
    writeFileSync(join(root, "bad-json", "codexclaw-plugin.json"), "{ nope");
    writeDescriptor(join(root, "bad-descriptor"), { ...validDescriptor(), id: "../bad" });
    writeDescriptor(join(root, "good"), validDescriptor({ id: "good", serverName: "good" }));

    const registry = discoverLocalPluginRegistry({ config: pluginConfig([root]) });

    expect(registry.entries.map((entry) => entry.status).sort()).toEqual(["available", "invalid", "invalid"]);
    expect(registry.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["invalid_json", "invalid_identifier"]));
  });

  test("rejects duplicate plugin ids and duplicate MCP server names deterministically", () => {
    const root = tempRoot();
    mkdirSync(join(root, "one"));
    mkdirSync(join(root, "two"));
    mkdirSync(join(root, "three"));
    mkdirSync(join(root, "four"));
    writeDescriptor(join(root, "one"), validDescriptor({ id: "same", serverName: "one" }));
    writeDescriptor(join(root, "two"), validDescriptor({ id: "same", serverName: "two" }));
    writeDescriptor(join(root, "three"), validDescriptor({ id: "three", serverName: "shared" }));
    writeDescriptor(join(root, "four"), validDescriptor({ id: "four", serverName: "shared" }));

    const store = new PointerStore();
    for (const id of ["same", "three", "four"]) store.setPluginEnablement({ pluginId: id, enabled: true });
    const registry = discoverLocalPluginRegistry({ config: pluginConfig([root]), store, env: { OPENCANDLE_ROOT: "/tmp/root" } });
    const projection = projectAppServerMcpConfig(registry.entries, { OPENCANDLE_ROOT: "/tmp/root" });

    expect(registry.entries.map((entry) => [entry.id, entry.status])).toEqual([
      ["four", "duplicate"],
      ["same", "duplicate"],
      ["same", "duplicate"],
      ["three", "duplicate"]
    ]);
    expect(projection.mcpServers).toEqual([]);
    expect(projection.omitted.every((item) => item.reason === "duplicate")).toBe(true);
    store.close();
  });

  test("persists enablement, detects version mismatch, and projects only allowlisted env", () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor());
    const store = new PointerStore();
    store.setPluginEnablement({ pluginId: "opencandle", version: "0.1.0", enabled: true });

    const registry = discoverLocalPluginRegistry({
      config: pluginConfig([root]),
      store,
      env: { OPENCANDLE_ROOT: "/tmp/opencandle", NOT_ALLOWLISTED: "secret" }
    });
    const projection = projectAppServerMcpConfig(registry.entries, {
      OPENCANDLE_ROOT: "/tmp/opencandle",
      NOT_ALLOWLISTED: "secret"
    });

    expect(registry.entries[0]).toMatchObject({ enabled: true, status: "available", missingEnvNames: [] });
    expect(projection.mcpServers).toEqual([
      {
        serverName: "opencandle",
        command: "/usr/local/bin/bun",
        args: ["server.ts"],
        env: [{ name: "OPENCANDLE_ROOT", value: "/tmp/opencandle" }]
      }
    ]);
    expect(JSON.stringify(projection)).not.toContain("NOT_ALLOWLISTED");
    expect(JSON.stringify(projection)).not.toContain("secret");

    store.setPluginEnablement({ pluginId: "opencandle", version: "9.9.9", enabled: true });
    const mismatch = discoverLocalPluginRegistry({
      config: pluginConfig([root]),
      store,
      env: { OPENCANDLE_ROOT: "/tmp/opencandle" }
    });
    expect(mismatch.entries[0]).toMatchObject({ enabled: false, status: "version_mismatch" });
    expect(projectAppServerMcpConfig(mismatch.entries, { OPENCANDLE_ROOT: "/tmp/opencandle" }).mcpServers).toEqual([]);
    store.close();
  });

  test("omits enabled plugins with missing required env by name only", () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor());
    const store = new PointerStore();
    store.setPluginEnablement({ pluginId: "opencandle", enabled: true });

    const registry = discoverLocalPluginRegistry({ config: pluginConfig([root]), store, env: {} });
    const projection = projectAppServerMcpConfig(registry.entries, {});

    expect(registry.entries[0]).toMatchObject({
      enabled: true,
      status: "missing_env",
      missingEnvNames: ["OPENCANDLE_ROOT"]
    });
    expect(projection.mcpServers).toEqual([]);
    expect(projection.omitted).toMatchObject([{ reason: "missing_env", missingEnvNames: ["OPENCANDLE_ROOT"] }]);
    expect(JSON.stringify(registry)).not.toContain("secret-value");
    store.close();
  });

  test("omits required env that is not allowlisted", () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor({ envAllowlist: [] }));
    const store = new PointerStore();
    store.setPluginEnablement({ pluginId: "opencandle", enabled: true });

    const registry = discoverLocalPluginRegistry({
      config: pluginConfig([root]),
      store,
      env: { OPENCANDLE_ROOT: "/tmp/opencandle" }
    });
    const projection = projectAppServerMcpConfig(registry.entries, { OPENCANDLE_ROOT: "/tmp/opencandle" });

    expect(registry.entries[0]).toMatchObject({
      enabled: true,
      status: "missing_env",
      missingEnvNames: ["OPENCANDLE_ROOT"]
    });
    expect(projection.mcpServers).toEqual([]);
    store.close();
  });

  test("treats blank required env values as missing", () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor());
    const store = new PointerStore();
    store.setPluginEnablement({ pluginId: "opencandle", enabled: true });

    const registry = discoverLocalPluginRegistry({ config: pluginConfig([root]), store, env: { OPENCANDLE_ROOT: "   " } });
    const projection = projectAppServerMcpConfig(registry.entries, { OPENCANDLE_ROOT: "   " });

    expect(registry.entries[0]).toMatchObject({
      enabled: true,
      status: "missing_env",
      missingEnvNames: ["OPENCANDLE_ROOT"]
    });
    expect(projection.mcpServers).toEqual([]);
    store.close();
  });

  test("projection can use a fresh env snapshot after discovery reported missing env", () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor());
    const store = new PointerStore();
    store.setPluginEnablement({ pluginId: "opencandle", enabled: true });

    const registry = discoverLocalPluginRegistry({ config: pluginConfig([root]), store, env: {} });
    const projection = projectAppServerMcpConfig(registry.entries, { OPENCANDLE_ROOT: "/tmp/opencandle" });

    expect(registry.entries[0]).toMatchObject({ status: "missing_env" });
    expect(projection.mcpServers).toEqual([
      {
        serverName: "opencandle",
        command: "/usr/local/bin/bun",
        args: ["server.ts"],
        env: [{ name: "OPENCANDLE_ROOT", value: "/tmp/opencandle" }]
      }
    ]);
    store.close();
  });

  test("rejects symlink escapes into denied roots without reading plugin commands", () => {
    const pluginRoot = tempRoot();
    const deniedRoot = tempRoot();
    mkdirSync(join(pluginRoot, "child"));
    writeDescriptor(deniedRoot, validDescriptor({ command: "/should/not/execute" }));
    symlinkSync(deniedRoot, join(pluginRoot, "denied-child"), "dir");
    symlinkSync(join(deniedRoot, "codexclaw-plugin.json"), join(pluginRoot, "child", "codexclaw-plugin.json"));

    const registry = discoverLocalPluginRegistry({ config: pluginConfig([pluginRoot], [deniedRoot]) });

    expect(registry.entries).toEqual([]);
    expect(registry.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["path_denied"]));
  });

  test("rejects configured plugin directory symlinks into denied roots", () => {
    const parent = tempRoot();
    const deniedRoot = tempRoot();
    const configuredLink = join(parent, "configured-link");
    writeDescriptor(deniedRoot, validDescriptor());
    symlinkSync(deniedRoot, configuredLink, "dir");

    const registry = discoverLocalPluginRegistry({ config: pluginConfig([configuredLink], [deniedRoot]) });

    expect(registry.entries).toEqual([]);
    expect(registry.diagnostics.map((item) => item.code)).toContain("path_denied");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codexclaw-plugin-test-"));
  roots.push(root);
  return root;
}

function pluginConfig(pluginDirs: readonly string[], deniedRoots: readonly string[] = []): PluginConfig {
  return {
    pluginDirs,
    maxDescriptorBytes: 64 * 1024,
    workspaceRoot: roots[0] ?? tmpdir(),
    deniedRoots
  };
}

function writeDescriptor(directory: string, descriptor: PluginDescriptorV1): void {
  writeFileSync(join(directory, "codexclaw-plugin.json"), JSON.stringify(descriptor, null, 2));
}

function validDescriptor(
  overrides: { id?: string; serverName?: string; command?: string; envAllowlist?: readonly string[] } = {}
): PluginDescriptorV1 {
  return {
    schemaVersion: 1,
    id: overrides.id ?? "opencandle",
    displayName: "OpenCandle",
    version: "0.1.0",
    description: "Market metadata provider.",
    mcp: {
      serverName: overrides.serverName ?? "opencandle",
      command: overrides.command ?? "/usr/local/bin/bun",
      args: ["server.ts"],
      env: [{ name: "OPENCANDLE_ROOT", required: true }]
    },
    tools: [{ name: "get_fear_greed" }],
    security: {
      network: "declared",
      providers: ["alternative.me"],
      envAllowlist: overrides.envAllowlist ?? ["OPENCANDLE_ROOT"]
    }
  };
}
