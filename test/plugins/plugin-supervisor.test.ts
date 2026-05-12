import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PluginSupervisor,
  renderAppServerMcpConfigToml,
  sanitizeAppServerEnvForPlugins,
  writeManagedMcpConfig,
  type AppServerMcpConfigProjection,
  type PluginDescriptorV1
} from "../../src/plugins/index.js";
import { PointerStore } from "../../src/store/pointer-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("plugin supervisor managed config", () => {
  test("renders app-server MCP TOML from projection without omitted plugins", () => {
    const projection = sampleProjection();
    const toml = renderAppServerMcpConfigToml(projection);

    expect(toml).toContain("[mcp_servers.opencandle]");
    expect(toml).toContain('command = "/usr/local/bin/bun"');
    expect(toml).toContain('args = ["server.ts"]');
    expect(toml).toContain('env = { OPENCANDLE_ROOT = "/tmp/opencandle" }');
    expect(toml).not.toContain("disabled");
    expect(toml).not.toContain("NOT_ALLOWLISTED");
  });

  test("writes managed config only as private state-owned config.toml", () => {
    const root = tempRoot();
    const codexHome = join(root, "state", "codex-home");
    const configPath = join(codexHome, "config.toml");

    writeManagedMcpConfig(sampleProjection(), { configPath, stateDir: codexHome });

    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain("[mcp_servers.opencandle]");
    expect(statSync(codexHome).mode & 0o077).toBe(0);
    expect(statSync(configPath).mode & 0o077).toBe(0);
  });

  test("rejects symlinked managed config path", () => {
    const root = tempRoot();
    const codexHome = join(root, "state", "codex-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const target = join(root, "target.toml");
    writeFileSync(target, "");
    symlinkSync(target, join(codexHome, "config.toml"));

    expect(() => writeManagedMcpConfig(sampleProjection(), { configPath: join(codexHome, "config.toml"), stateDir: codexHome })).toThrow(
      "Refusing symlink"
    );
  });

  test("rejects config writes outside managed CODEX_HOME", () => {
    const root = tempRoot();
    const codexHome = join(root, "state", "codex-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });

    expect(() => writeManagedMcpConfig(sampleProjection(), { configPath: join(root, "config.toml"), stateDir: codexHome })).toThrow(
      "Managed MCP config"
    );
  });

  test("sanitizes app-server parent env before plugin-capable startup", () => {
    const env = sanitizeAppServerEnvForPlugins(
      {
        PATH: "/bin",
        HOME: "/home/user",
        CODEXCLAW_TELEGRAM_BOT_TOKEN: "telegram-secret",
        CODEXCLAW_CODEX_TOKEN_FILE: "/state/codex.token",
        OPENAI_API_KEY: "provider-secret",
        RANDOM_SECRET: "secret"
      },
      "/state/codex-home"
    );

    expect(env).toEqual({ PATH: "/bin", HOME: "/home/user", CODEX_HOME: "/state/codex-home" });
    expect(JSON.stringify(env)).not.toContain("telegram-secret");
    expect(JSON.stringify(env)).not.toContain("provider-secret");
    expect(lstatSync(tempRoot()).isDirectory()).toBe(true);
  });

  test("reconciles enabled projection into metadata-only ready status", async () => {
    const root = tempRoot();
    const pluginDir = join(root, "plugin");
    const codexHome = join(root, "state", "codex-home");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "codexclaw-plugin.json"), JSON.stringify(validDescriptor(), null, 2));
    const store = new PointerStore();
    store.setPluginEnablement({ pluginId: "opencandle", enabled: true });
    const codex = new FakeMcpCodex(["opencandle"]);
    const supervisor = new PluginSupervisor({
      pluginConfig: { pluginDirs: [pluginDir], maxDescriptorBytes: 64 * 1024, workspaceRoot: root, deniedRoots: [] },
      supervisorConfig: {
        enabled: true,
        managedCodexHome: codexHome,
        managedConfigPath: join(codexHome, "config.toml"),
        startupTimeoutMs: 100,
        backoffBaseMs: 10,
        backoffMaxMs: 100,
        maxRestartAttempts: 1,
        diagnosticMaxChars: 80
      },
      store,
      codex,
      env: { OPENCANDLE_ROOT: "/tmp/opencandle" }
    });

    supervisor.reconcile("startup");
    await tick();

    expect(codex.reloadCount).toBe(1);
    expect(supervisor.snapshot().statuses).toMatchObject([
      {
        pluginId: "opencandle",
        serverName: "opencandle",
        desired: "running",
        state: "ready",
        missingEnvNames: []
      }
    ]);
    expect(JSON.stringify(supervisor.snapshot())).not.toContain("/tmp/opencandle");
    supervisor.close();
    store.close();
  });

  test("reloads app-server when allowlisted env values change without exposing raw values", async () => {
    const env: Record<string, string> = { OPENCANDLE_ROOT: "/tmp/opencandle-a" };
    const { supervisor, store, codex } = enabledSupervisorFixture({ observedServers: ["opencandle"], env });

    supervisor.reconcile("startup");
    await tick();
    env.OPENCANDLE_ROOT = "/tmp/opencandle-b";
    supervisor.reconcile("manual");
    await tick();

    expect(codex.reloadCount).toBe(2);
    expect(JSON.stringify(supervisor.snapshot())).not.toContain("/tmp/opencandle-a");
    expect(JSON.stringify(supervisor.snapshot())).not.toContain("/tmp/opencandle-b");
    supervisor.close();
    store.close();
  });

  test("marks enabled plugin failed when app-server status omits it", async () => {
    const { supervisor, store } = enabledSupervisorFixture({ observedServers: [] });

    supervisor.reconcile("startup");
    await tick();

    expect(supervisor.snapshot().statuses).toMatchObject([
      {
        pluginId: "opencandle",
        desired: "running",
        state: "failed",
        lastErrorSummary: "app-server status did not include enabled plugin server"
      }
    ]);
    supervisor.close();
    store.close();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codexclaw-plugin-supervisor-test-"));
  roots.push(root);
  return root;
}

function sampleProjection(): AppServerMcpConfigProjection {
  return {
    mcpServers: [
      {
        serverName: "opencandle",
        command: "/usr/local/bin/bun",
        args: ["server.ts"],
        env: [{ name: "OPENCANDLE_ROOT", value: "/tmp/opencandle" }]
      }
    ],
    omitted: [{ pluginId: "disabled", sourceLabel: "disabled", reason: "disabled", missingEnvNames: [] }]
  };
}

function validDescriptor(): PluginDescriptorV1 {
  return {
    schemaVersion: 1,
    id: "opencandle",
    displayName: "OpenCandle",
    version: "0.1.0",
    mcp: {
      serverName: "opencandle",
      command: "/usr/local/bin/bun",
      args: ["server.ts"],
      env: [{ name: "OPENCANDLE_ROOT", required: true }]
    },
    security: {
      network: "declared",
      providers: ["alternative.me"],
      envAllowlist: ["OPENCANDLE_ROOT"]
    }
  };
}

class FakeMcpCodex {
  reloadCount = 0;

  constructor(private readonly serverNames: readonly string[]) {}

  async reloadMcpServers(): Promise<void> {
    this.reloadCount += 1;
  }

  async listMcpServerStatus(): Promise<{ data: Array<{ name: string }>; nextCursor: null }> {
    return { data: this.serverNames.map((name) => ({ name })), nextCursor: null };
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function enabledSupervisorFixture(options: {
  observedServers: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}): { supervisor: PluginSupervisor; store: PointerStore; codex: FakeMcpCodex } {
  const root = tempRoot();
  const pluginDir = join(root, "plugin");
  const codexHome = join(root, "state", "codex-home");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "codexclaw-plugin.json"), JSON.stringify(validDescriptor(), null, 2));
  const store = new PointerStore();
  store.setPluginEnablement({ pluginId: "opencandle", enabled: true });
  const codex = new FakeMcpCodex(options.observedServers);
  return {
    store,
    codex,
    supervisor: new PluginSupervisor({
      pluginConfig: { pluginDirs: [pluginDir], maxDescriptorBytes: 64 * 1024, workspaceRoot: root, deniedRoots: [] },
      supervisorConfig: {
        enabled: true,
        managedCodexHome: codexHome,
        managedConfigPath: join(codexHome, "config.toml"),
        startupTimeoutMs: 100,
        backoffBaseMs: 10,
        backoffMaxMs: 100,
        maxRestartAttempts: 1,
        diagnosticMaxChars: 80
      },
      store,
      codex,
      env: options.env ?? { OPENCANDLE_ROOT: "/tmp/opencandle" }
    })
  };
}
