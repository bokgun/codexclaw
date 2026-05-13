import type { PluginConfig } from "../config/env.js";
import type { PluginEnablementState } from "../store/pointer-store.js";
import { discoverLocalPluginRegistry } from "./registry.js";
import { isValidPluginId, sanitizeDisplayString } from "./security.js";
import type { LocalPluginRegistryEntry, PluginValidationDiagnostic, SupervisedPluginStatus } from "./types.js";

export interface PluginCommandService {
  list(): Promise<string>;
  status(pluginId: string): Promise<string>;
  previewEnable(pluginId: string): Promise<string>;
  confirmEnable(pluginId: string): Promise<string>;
  disable(pluginId: string): Promise<string>;
}

export interface PluginCommandServiceOptions {
  pluginConfig: PluginConfig;
  store: PluginCommandStore;
  env?: Readonly<Record<string, string | undefined>>;
  supervisorSnapshot?: () => PluginCommandSupervisorSnapshot | undefined;
  reconcile?: () => string | undefined | Promise<string | undefined>;
}

export interface PluginCommandStore {
  listPluginEnablement(): PluginEnablementState[];
  setPluginEnablement(input: { pluginId: string; version?: string; enabled: boolean }): PluginEnablementState;
}

export interface PluginCommandSupervisorSnapshot {
  enabled: boolean;
  statuses: readonly SupervisedPluginStatus[];
}

interface PluginView {
  pluginId: string;
  version?: string;
  sourceLabel?: string;
  entry?: LocalPluginRegistryEntry;
  persisted?: PluginEnablementState;
  supervisor?: SupervisedPluginStatus;
}

const DISPLAY_MAX = 240;

export function createPluginCommandService(options: PluginCommandServiceOptions): PluginCommandService {
  return new DefaultPluginCommandService(options);
}

class DefaultPluginCommandService implements PluginCommandService {
  constructor(private readonly options: PluginCommandServiceOptions) {}

  async list(): Promise<string> {
    const views = this.views();
    if (views.length === 0) return "No local plugins discovered.";

    return [
      "Plugins:",
      ...views.map((view) => {
        const entry = view.entry;
        const summary = entry?.summary;
        const state = enabledLabel(view);
        const status = entry?.status ?? "stale";
        const security = securityLabel(entry);
        const supervisor = view.supervisor ? ` supervisor=${view.supervisor.state}` : "";
        const name = summary?.displayName ? ` ${safe(summary.displayName, 80)}` : "";
        return `- ${view.pluginId}${name} ${state} status=${status}${security}${supervisor}`;
      })
    ].join("\n");
  }

  async status(pluginId: string): Promise<string> {
    const view = this.requireView(pluginId, { allowStale: true });
    return this.renderStatus(view);
  }

  async previewEnable(pluginId: string): Promise<string> {
    const view = this.requireEnableableView(pluginId);
    return [
      this.renderStatus(view),
      "",
      "Enablement preview only. No state was changed.",
      `To enable explicitly, run: /plugin enable ${view.pluginId} --confirm`
    ].join("\n");
  }

  async confirmEnable(pluginId: string): Promise<string> {
    const view = this.requireEnableableView(pluginId);
    const entry = view.entry!;
    this.options.store.setPluginEnablement({ pluginId: entry.id, version: entry.version, enabled: true });
    const reconcileWarning = await this.requestReconcile();
    const missing = missingEnvNames(entry, this.env());
    return [
      `Enabled plugin '${entry.id}'.`,
      missing.length > 0 ? `Not runnable until required env is configured: ${missing.join(", ")}` : "Runtime reconcile requested.",
      reconcileWarning
    ]
      .filter(Boolean)
      .join("\n");
  }

  async disable(pluginId: string): Promise<string> {
    const view = this.requireView(pluginId, { allowStale: true });
    this.options.store.setPluginEnablement({ pluginId: view.pluginId, version: view.version, enabled: false });
    const reconcileWarning = await this.requestReconcile();
    return [`Disabled plugin '${view.pluginId}'.`, reconcileWarning].filter(Boolean).join("\n");
  }

  private renderStatus(view: PluginView): string {
    const entry = view.entry;
    if (!entry) {
      return [
        `Plugin '${view.pluginId}'`,
        `State: ${enabledLabel(view)}`,
        "Registry status: stale",
        "Descriptor is no longer discoverable. Use /plugin disable <id> to clear persisted enablement."
      ].join("\n");
    }

    const summary = entry.summary;
    const descriptor = entry.descriptor;
    const missing = missingEnvNames(entry, this.env());
    const diagnostics = formatDiagnostics(entry.diagnostics);
    const tools = summary?.tools.length
      ? summary.tools.map((tool) => `- ${safe(tool.name, 80)}${tool.title ? `: ${safe(tool.title, 120)}` : ""}`).join("\n")
      : "none";
    const supervisor = view.supervisor
      ? `${view.supervisor.state} desired=${view.supervisor.desired} restarts=${view.supervisor.restartCount}${
          view.supervisor.lastErrorSummary ? ` error=${safe(view.supervisor.lastErrorSummary, DISPLAY_MAX)}` : ""
        }`
      : this.options.supervisorSnapshot?.()?.enabled
        ? "unknown"
        : "disabled";

    return [
      `Plugin '${entry.id}'`,
      `Name: ${summary ? safe(summary.displayName, 120) : "unknown"}`,
      `Version: ${entry.version ?? "unversioned"}`,
      `State: ${enabledLabel(view)}`,
      `Registry status: ${entry.status}`,
      `Source: ${safe(entry.sourceLabel, 120)}`,
      `Server: ${summary ? safe(summary.serverName, 80) : safe(entry.id, 80)}`,
      `Network: ${descriptor?.security.network ?? summary?.security.network ?? "unknown"}`,
      `Providers: ${providerNames(entry).join(", ") || "none"}`,
      `Env names: ${envNames(entry).join(", ") || "none"}`,
      `Missing env: ${missing.join(", ") || "none"}`,
      "Elicitation: fail_closed",
      `Supervisor: ${supervisor}`,
      "Tools:",
      tools,
      diagnostics.length > 0 ? "Diagnostics:" : undefined,
      diagnostics.length > 0 ? diagnostics.join("\n") : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private requireEnableableView(pluginId: string): PluginView {
    const normalized = normalizePluginId(pluginId);
    const matches = this.views().filter((view) => view.pluginId === normalized);
    if (matches.length === 0 || !matches[0]?.entry) {
      throw new Error(`Unknown plugin '${safe(pluginId, 80)}'.`);
    }
    if (matches.length > 1 || matches.some((view) => view.entry?.status === "duplicate")) {
      throw new Error(`Plugin '${normalized}' cannot be enabled while status is duplicate.`);
    }
    const view = matches[0];
    const entry = view.entry!;
    if (!entry.descriptor) throw new Error(`Plugin '${entry.id}' is invalid and cannot be enabled.`);
    if (entry.status === "invalid" || entry.status === "duplicate" || entry.status === "version_mismatch") {
      throw new Error(`Plugin '${entry.id}' cannot be enabled while status is ${entry.status}.`);
    }
    return view;
  }

  private requireView(pluginId: string, options: { allowStale?: boolean } = {}): PluginView {
    const normalized = normalizePluginId(pluginId);
    const matches = this.views().filter((view) => view.pluginId === normalized);
    if (matches.length === 0) throw new Error(`Unknown plugin '${safe(pluginId, 80)}'.`);
    if (matches.length > 1 && !matches.some((view) => view.entry?.status === "duplicate")) {
      throw new Error(`Plugin '${normalized}' is ambiguous.`);
    }
    const view = matches[0]!;
    if (!view.entry && !options.allowStale) throw new Error(`Plugin '${normalized}' is stale.`);
    return view;
  }

  private views(): PluginView[] {
    const env = this.env();
    const registry = discoverLocalPluginRegistry({ config: this.options.pluginConfig, store: this.options.store, env });
    const persisted = new Map(this.options.store.listPluginEnablement().map((state) => [state.pluginId, state]));
    const supervisors = new Map((this.options.supervisorSnapshot?.()?.statuses ?? []).map((status) => [status.pluginId, status]));
    const views: PluginView[] = registry.entries.map((entry) => ({
      pluginId: entry.id,
      version: entry.version,
      sourceLabel: entry.sourceLabel,
      entry,
      persisted: persisted.get(entry.id),
      supervisor: supervisors.get(entry.id)
    }));

    const discoveredIds = new Set(registry.entries.map((entry) => entry.id));
    for (const state of persisted.values()) {
      if (discoveredIds.has(state.pluginId)) continue;
      views.push({
        pluginId: state.pluginId,
        version: state.version,
        persisted: state,
        supervisor: supervisors.get(state.pluginId)
      });
    }

    return views.sort((left, right) => left.pluginId.localeCompare(right.pluginId) || (left.sourceLabel ?? "").localeCompare(right.sourceLabel ?? ""));
  }

  private async requestReconcile(): Promise<string | undefined> {
    try {
      const warning = await this.options.reconcile?.();
      return warning ? `Reconcile warning: ${safe(warning, DISPLAY_MAX)}` : undefined;
    } catch (error) {
      return `Reconcile warning: ${safe(error instanceof Error ? error.message : String(error), DISPLAY_MAX)}`;
    }
  }

  private env(): Readonly<Record<string, string | undefined>> {
    return this.options.env ?? process.env;
  }
}

function normalizePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (!isValidPluginId(normalized)) throw new Error("Invalid plugin id.");
  return normalized;
}

function enabledLabel(view: PluginView): string {
  const enabled = view.entry?.enabled ?? view.persisted?.enabled ?? false;
  return enabled ? "enabled" : "disabled";
}

function securityLabel(entry: LocalPluginRegistryEntry | undefined): string {
  if (!entry?.descriptor) return "";
  const parts = [];
  if (entry.descriptor.security.network !== "none") parts.push("network");
  if (entry.descriptor.security.providers.length > 0) parts.push(`providers=${entry.descriptor.security.providers.map((item) => safe(item, 80)).join(",")}`);
  return parts.length > 0 ? ` security=${parts.join(" ")}` : " security=local";
}

function providerNames(entry: LocalPluginRegistryEntry): string[] {
  return (entry.descriptor?.security.providers ?? entry.summary?.security.providers ?? []).map((item) => safe(item, 80));
}

function envNames(entry: LocalPluginRegistryEntry): string[] {
  return (entry.descriptor?.mcp.env ?? []).map((item) => item.name).sort();
}

function missingEnvNames(entry: LocalPluginRegistryEntry, env: Readonly<Record<string, string | undefined>>): string[] {
  const descriptor = entry.descriptor;
  if (!descriptor) return [...entry.missingEnvNames];
  const allowed = new Set(descriptor.security.envAllowlist);
  return descriptor.mcp.env
    .filter((item) => item.required && (!allowed.has(item.name) || isMissingEnv(env[item.name])))
    .map((item) => item.name)
    .sort();
}

function isMissingEnv(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function formatDiagnostics(diagnostics: readonly PluginValidationDiagnostic[]): string[] {
  return diagnostics.slice(0, 6).map((item) => `- ${safe(item.path, 80)} ${item.code}: ${safe(item.message, DISPLAY_MAX)}`);
}

function safe(value: string, maxLength: number): string {
  return sanitizeDisplayString(value, maxLength);
}
