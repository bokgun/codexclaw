import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import type { McpServerStatusListResponse, McpServerStatusSummary } from "../codex/runtime-client.js";
import type { PluginConfig, PluginSupervisorEnvConfig } from "../config/env.js";
import type { RuntimeLogger } from "../runtime/log.js";
import type { RuntimeEvent } from "../runtime/types.js";
import type { PointerStore } from "../store/pointer-store.js";
import { discoverLocalPluginRegistry, projectAppServerMcpConfig } from "./registry.js";
import { sanitizeDisplayString } from "./security.js";
import type {
  AppServerMcpConfigProjection,
  AppServerMcpStatusSummary,
  LocalPluginRegistryEntry,
  PluginSupervisorConfig,
  SupervisedPluginStatus
} from "./types.js";

export interface PluginSupervisorOptions {
  pluginConfig: PluginConfig;
  supervisorConfig: PluginSupervisorEnvConfig;
  store: Pick<PointerStore, "listPluginEnablement">;
  codex: {
    reloadMcpServers(): Promise<void>;
    listMcpServerStatus(): Promise<McpServerStatusListResponse>;
  };
  logger?: RuntimeLogger;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

export interface ManagedMcpConfigWriteOptions {
  configPath: string;
  stateDir: string;
}

export interface PluginSupervisorSnapshot {
  enabled: boolean;
  projectionHash?: string;
  statuses: readonly SupervisedPluginStatus[];
}

type ReconcileReason = "startup" | "reconnect" | "manual" | "runtime_event";

export class PluginSupervisor {
  private readonly statuses = new Map<string, SupervisedPluginStatus>();
  private readonly config: PluginSupervisorConfig;
  private readonly now: () => Date;
  private projectionHash?: string;
  private reconcileInFlight = false;
  private closed = false;
  private backoffTimer?: ReturnType<typeof setTimeout>;
  private restartCount = 0;

  constructor(private readonly options: PluginSupervisorOptions) {
    this.config = {
      startupTimeoutMs: options.supervisorConfig.startupTimeoutMs,
      backoffBaseMs: options.supervisorConfig.backoffBaseMs,
      backoffMaxMs: options.supervisorConfig.backoffMaxMs,
      maxRestartAttempts: options.supervisorConfig.maxRestartAttempts,
      diagnosticMaxChars: options.supervisorConfig.diagnosticMaxChars
    };
    this.now = options.now ?? (() => new Date());
  }

  snapshot(): PluginSupervisorSnapshot {
    return {
      enabled: this.options.supervisorConfig.enabled,
      projectionHash: this.projectionHash,
      statuses: [...this.statuses.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId))
    };
  }

  reconcile(reason: ReconcileReason = "manual"): void {
    if (!this.options.supervisorConfig.enabled || this.closed || this.reconcileInFlight) return;

    this.reconcileInFlight = true;
    void this.reconcileNow(reason).finally(() => {
      this.reconcileInFlight = false;
    });
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.kind !== "mcp_server_startup_status") return;
    const current = this.findStatusByServerName(event.serverName);
    if (!current) return;
    this.setStatus(current.pluginId, {
      ...current,
      state: toSupervisorState(event.startupState),
      lastErrorSummary: event.errorSummary
        ? sanitizeDisplayString(event.errorSummary, this.config.diagnosticMaxChars)
        : current.lastErrorSummary,
      lastTransitionAt: this.now().toISOString()
    });
  }

  close(): void {
    this.closed = true;
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = undefined;
  }

  private async reconcileNow(reason: ReconcileReason): Promise<void> {
    const registry = discoverLocalPluginRegistry({
      config: this.options.pluginConfig,
      store: this.options.store,
      env: this.options.env ?? process.env
    });
    const projection = projectAppServerMcpConfig(registry.entries, this.options.env ?? process.env);
    const nextHash = projectionHash(projection);
    const now = this.now().toISOString();

    this.replaceDesiredStatuses(registry.entries, now);

    try {
      writeManagedMcpConfig(projection, {
        configPath: this.options.supervisorConfig.managedConfigPath,
        stateDir: this.options.supervisorConfig.managedCodexHome
      });
      if (nextHash !== this.projectionHash || reason === "reconnect") {
        await withTimeout(this.options.codex.reloadMcpServers(), this.config.startupTimeoutMs);
        this.projectionHash = nextHash;
      }

      const statusList = await withTimeout(this.options.codex.listMcpServerStatus(), this.config.startupTimeoutMs);
      this.applyObservedStatus(statusList, now);
      this.restartCount = 0;
      if (reason !== "runtime_event") this.options.logger?.info("plugin_supervisor_reconciled", summarizeProjection(projection));
    } catch (error) {
      this.markProjectionFailure(error);
      this.scheduleBackoff();
    }
  }

  private replaceDesiredStatuses(entries: readonly LocalPluginRegistryEntry[], now: string): void {
    const next = new Map<string, SupervisedPluginStatus>();
    for (const entry of entries) {
      const descriptor = entry.descriptor;
      const current = this.statuses.get(entry.id);
      const desired = entry.enabled && entry.status === "available" && descriptor ? "running" : "stopped";
      next.set(entry.id, {
        pluginId: entry.id,
        version: entry.version,
        serverName: descriptor?.mcp.serverName ?? entry.id,
        sourceLabel: entry.sourceLabel,
        desired,
        state: desired === "running" ? current?.state ?? "starting" : "disabled",
        restartCount: current?.restartCount ?? 0,
        lastTransitionAt: current?.lastTransitionAt ?? now,
        lastErrorSummary: current?.lastErrorSummary,
        missingEnvNames: [...entry.missingEnvNames]
      });
    }
    this.statuses.clear();
    for (const [pluginId, status] of next) this.statuses.set(pluginId, status);
  }

  private applyObservedStatus(statusList: McpServerStatusListResponse, now: string): void {
    const byServerName = new Map(statusList.data.map((status) => [status.name, mcpStatusSummary(status)]));
    for (const status of this.statuses.values()) {
      if (status.desired !== "running") continue;
      const observed = byServerName.get(status.serverName);
      if (!observed) {
        this.setStatus(status.pluginId, {
          ...status,
          state: "failed",
          lastErrorSummary: "app-server status did not include enabled plugin server",
          lastTransitionAt: now
        });
        continue;
      }
      this.setStatus(status.pluginId, {
        ...status,
        state: toSupervisorState(observed.startupState),
        lastErrorSummary: observed.errorSummary ? sanitizeDisplayString(observed.errorSummary, this.config.diagnosticMaxChars) : undefined,
        lastTransitionAt: now
      });
    }
  }

  private markProjectionFailure(error: unknown): void {
    const summary = sanitizeDisplayString(error instanceof Error ? error.message : String(error), this.config.diagnosticMaxChars);
    const now = this.now().toISOString();
    for (const status of this.statuses.values()) {
      if (status.desired !== "running") continue;
      this.setStatus(status.pluginId, {
        ...status,
        state: this.restartCount >= this.config.maxRestartAttempts ? "failed" : "backing_off",
        restartCount: this.restartCount,
        lastErrorSummary: summary,
        lastTransitionAt: now
      });
    }
    this.options.logger?.warn("plugin_supervisor_reconcile_failed", { error: summary });
  }

  private scheduleBackoff(): void {
    if (this.closed || this.restartCount >= this.config.maxRestartAttempts) return;
    this.restartCount += 1;
    const delayMs = Math.min(this.config.backoffMaxMs, this.config.backoffBaseMs * 2 ** Math.max(0, this.restartCount - 1));
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = setTimeout(() => this.reconcile("manual"), delayMs);
  }

  private findStatusByServerName(serverName: string): SupervisedPluginStatus | undefined {
    for (const status of this.statuses.values()) {
      if (status.serverName === serverName) return status;
    }
    return undefined;
  }

  private setStatus(pluginId: string, status: SupervisedPluginStatus): void {
    this.statuses.set(pluginId, status);
  }
}

export function renderAppServerMcpConfigToml(projection: AppServerMcpConfigProjection): string {
  const lines = ["# Managed by codexclaw. Do not store secrets outside allowlisted MCP env values.", ""];
  for (const server of [...projection.mcpServers].sort((left, right) => left.serverName.localeCompare(right.serverName))) {
    lines.push(`[mcp_servers.${quoteTomlKey(server.serverName)}]`);
    lines.push(`command = ${quoteTomlString(server.command)}`);
    lines.push(`args = [${server.args.map(quoteTomlString).join(", ")}]`);
    if (server.env.length > 0) {
      const envEntries = [...server.env].sort((left, right) => left.name.localeCompare(right.name));
      lines.push(`env = { ${envEntries.map((item) => `${quoteTomlKey(item.name)} = ${quoteTomlString(item.value)}`).join(", ")} }`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function writeManagedMcpConfig(projection: AppServerMcpConfigProjection, options: ManagedMcpConfigWriteOptions): void {
  const stateDir = ensurePrivateStateDir(options.stateDir);
  const requestedConfigPath = resolve(options.configPath);
  if (basename(requestedConfigPath) !== "config.toml") {
    throw new Error("Managed MCP config must be CODEXCLAW_PLUGIN_MANAGED_CODEX_HOME/config.toml");
  }
  refuseSymlink(requestedConfigPath, "managed MCP config");
  const parentReal = realpathSync(dirname(requestedConfigPath));
  if (parentReal !== stateDir) throw new Error("Managed MCP config parent must stay inside codexclaw state-owned CODEX_HOME");
  const configPath = resolve(stateDir, "config.toml");

  const tmpPath = resolve(stateDir, `.config.toml.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, renderAppServerMcpConfigToml(projection), { mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, configPath);
  chmodSync(configPath, 0o600);
}

export function sanitizeAppServerEnvForPlugins(
  env: Readonly<Record<string, string | undefined>>,
  managedCodexHome: string
): Record<string, string> {
  const allowed = new Set(["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL"]);
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value || !allowed.has(key) || /TOKEN|SECRET|PASSWORD|KEY|AUTH/i.test(key)) continue;
    next[key] = value;
  }
  next.CODEX_HOME = managedCodexHome;
  return next;
}

function ensurePrivateStateDir(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true, mode: 0o700 });
  refuseSymlink(resolved, "managed CODEX_HOME");
  const stat = statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Managed CODEX_HOME must be a directory: ${resolved}`);
  if (stat.uid === process.getuid?.() && (stat.mode & 0o077) !== 0) chmodSync(resolved, stat.mode & 0o700);
  const updated = statSync(resolved);
  if ((updated.mode & 0o077) !== 0) throw new Error(`Managed CODEX_HOME must not be group/world accessible: ${resolved}`);
  return realpathSync(resolved);
}

function refuseSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlink ${label}: ${path}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function projectionHash(projection: AppServerMcpConfigProjection): string {
  const canonical = JSON.stringify({
    mcpServers: [...projection.mcpServers]
      .map((server) => ({
        serverName: server.serverName,
        command: server.command,
        args: [...server.args],
        env: [...server.env].map((item) => ({ name: item.name, value: item.value })).sort((left, right) => left.name.localeCompare(right.name))
      }))
      .sort((left, right) => left.serverName.localeCompare(right.serverName))
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function summarizeProjection(projection: AppServerMcpConfigProjection): { serverCount: number; omittedCount: number; servers: readonly string[] } {
  return {
    serverCount: projection.mcpServers.length,
    omittedCount: projection.omitted.length,
    servers: projection.mcpServers.map((server) => server.serverName)
  };
}

function mcpStatusSummary(status: McpServerStatusSummary): AppServerMcpStatusSummary {
  return {
    serverName: status.name,
    startupState: "ready",
    toolCount: status.tools ? Object.keys(status.tools).length : undefined,
    resourceCount: status.resources?.length
  };
}

function toSupervisorState(state: AppServerMcpStatusSummary["startupState"]): SupervisedPluginStatus["state"] {
  if (state === "ready") return "ready";
  if (state === "failed" || state === "cancelled") return "failed";
  if (state === "starting") return "starting";
  return "failed";
}

function quoteTomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : quoteTomlString(value);
}

function quoteTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Plugin supervisor operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
