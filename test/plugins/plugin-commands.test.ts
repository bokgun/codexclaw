import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "../../src/config/env.js";
import { createPluginCommandService, type PluginDescriptorV1 } from "../../src/plugins/index.js";
import { PointerStore } from "../../src/store/pointer-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PluginCommandService", () => {
  test("renders bounded plugin metadata without env values or raw MCP args", async () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor());
    const store = new PointerStore();
    const service = createPluginCommandService({
      pluginConfig: pluginConfig([root]),
      store,
      env: { OPENCANDLE_ROOT: "secret-value" }
    });

    const list = await service.list();
    const status = await service.status("opencandle");

    expect(list).toContain("opencandle");
    expect(list).toContain("security=network");
    expect(status).toContain("Providers: alternative.me");
    expect(status).toContain("Env names: OPENCANDLE_ROOT");
    expect(status).toContain("Missing env: none");
    expect(`${list}\n${status}`).not.toContain("secret-value");
    expect(`${list}\n${status}`).not.toContain("server.ts");
    expect(`${list}\n${status}`).not.toContain("/usr/local/bin/bun");
    store.close();
  });

  test("enable preview does not mutate state and confirm persists identity only", async () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor());
    const store = new PointerStore();
    let reconciles = 0;
    const service = createPluginCommandService({
      pluginConfig: pluginConfig([root]),
      store,
      env: {},
      reconcile: () => {
        reconciles += 1;
        return undefined;
      }
    });

    const preview = await service.previewEnable("opencandle");
    expect(preview).toContain("/plugin enable opencandle --confirm");
    expect(store.getPluginEnablement("opencandle")).toBeUndefined();

    const enabled = await service.confirmEnable("opencandle");
    expect(enabled).toContain("Enabled plugin 'opencandle'.");
    expect(enabled).toContain("Not runnable until required env is configured: OPENCANDLE_ROOT");
    expect(store.getPluginEnablement("opencandle")).toMatchObject({
      pluginId: "opencandle",
      version: "0.1.0",
      enabled: true
    });
    expect(store.schemaColumns("plugin_enablement")).toEqual(["plugin_id", "version", "enabled", "created_at", "updated_at"]);
    expect(reconciles).toBe(1);
    store.close();
  });

  test("reports required env omitted from allowlist as missing", async () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor({ envAllowlist: [] }));
    const store = new PointerStore();
    const service = createPluginCommandService({
      pluginConfig: pluginConfig([root]),
      store,
      env: { OPENCANDLE_ROOT: "present-but-not-allowlisted" }
    });

    const status = await service.status("opencandle");
    const enabled = await service.confirmEnable("opencandle");

    expect(status).toContain("Missing env: OPENCANDLE_ROOT");
    expect(enabled).toContain("Not runnable until required env is configured: OPENCANDLE_ROOT");
    expect(`${status}\n${enabled}`).not.toContain("present-but-not-allowlisted");
    store.close();
  });

  test("keeps enablement persisted when reconcile reports a bounded warning", async () => {
    const root = tempRoot();
    writeDescriptor(root, validDescriptor());
    const store = new PointerStore();
    const service = createPluginCommandService({
      pluginConfig: pluginConfig([root]),
      store,
      env: { OPENCANDLE_ROOT: "ok" },
      reconcile: () => "reload failed"
    });

    const enabled = await service.confirmEnable("opencandle");

    expect(enabled).toContain("Enabled plugin 'opencandle'.");
    expect(enabled).toContain("Reconcile warning: reload failed");
    expect(store.getPluginEnablement("opencandle")).toMatchObject({ enabled: true });
    store.close();
  });

  test("rejects invalid duplicate and version-mismatched enablement", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "one"));
    mkdirSync(join(root, "two"));
    mkdirSync(join(root, "mismatch"));
    writeDescriptor(join(root, "one"), validDescriptor({ id: "same", serverName: "one" }));
    writeDescriptor(join(root, "two"), validDescriptor({ id: "same", serverName: "two" }));
    writeDescriptor(join(root, "mismatch"), validDescriptor({ id: "mismatch", serverName: "mismatch" }));
    const store = new PointerStore();
    store.setPluginEnablement({ pluginId: "mismatch", version: "9.9.9", enabled: true });
    const service = createPluginCommandService({ pluginConfig: pluginConfig([root]), store, env: { OPENCANDLE_ROOT: "ok" } });

    await expect(service.confirmEnable("same")).rejects.toThrow("cannot be enabled while status is duplicate");
    await expect(service.confirmEnable("mismatch")).rejects.toThrow("cannot be enabled while status is version_mismatch");
    store.close();
  });

  test("disables stale persisted plugin ids", async () => {
    const store = new PointerStore();
    store.setPluginEnablement({ pluginId: "stale", version: "0.1.0", enabled: true });
    const service = createPluginCommandService({ pluginConfig: pluginConfig([]), store, env: {} });

    const status = await service.status("stale");
    const disabled = await service.disable("stale");

    expect(status).toContain("Registry status: stale");
    expect(disabled).toContain("Disabled plugin 'stale'.");
    expect(store.getPluginEnablement("stale")).toMatchObject({ enabled: false });
    store.close();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codexclaw-plugin-command-test-"));
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
    tools: [{ name: "get_fear_greed", title: "Fear and greed" }],
    security: {
      network: "declared",
      providers: ["alternative.me"],
      envAllowlist: overrides.envAllowlist ?? ["OPENCANDLE_ROOT"]
    }
  };
}
