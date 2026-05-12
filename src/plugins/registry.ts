import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { PluginConfig } from "../config/env.js";
import type { PluginEnablementState, PointerStore } from "../store/pointer-store.js";
import { diagnostic, sanitizeDisplayString } from "./security.js";
import {
  type AppServerMcpConfigProjection,
  type LocalPluginRegistry,
  type LocalPluginRegistryEntry,
  type PluginProjectionOmission,
  type PluginValidationDiagnostic
} from "./types.js";
import { validatePluginDescriptor } from "./validation.js";

export const PLUGIN_DESCRIPTOR_FILENAME = "codexclaw-plugin.json";

export interface DiscoverLocalPluginRegistryInput {
  config: PluginConfig;
  store?: Pick<PointerStore, "listPluginEnablement">;
  env?: Readonly<Record<string, string | undefined>>;
}

interface DescriptorCandidate {
  sourcePath: string;
  sourceLabel: string;
}

export function discoverLocalPluginRegistry(input: DiscoverLocalPluginRegistryInput): LocalPluginRegistry {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const enablement = new Map((input.store?.listPluginEnablement() ?? []).map((state) => [state.pluginId, state]));
  const candidates = discoverDescriptorCandidates(input.config, diagnostics);
  const entries = candidates.map((candidate) => readRegistryEntry(candidate, input.config.maxDescriptorBytes, enablement, input.env ?? {}));

  applyDuplicateStatus(entries);
  for (const entry of entries) diagnostics.push(...entry.diagnostics);

  entries.sort((left, right) => left.id.localeCompare(right.id) || left.sourcePath.localeCompare(right.sourcePath));
  return { entries, diagnostics };
}

export function projectAppServerMcpConfig(
  entries: readonly LocalPluginRegistryEntry[],
  env: Readonly<Record<string, string | undefined>> = {}
): AppServerMcpConfigProjection {
  const mcpServers = [];
  const omitted: PluginProjectionOmission[] = [];

  for (const entry of entries) {
    if (entry.enabled && (entry.status === "available" || entry.status === "missing_env") && entry.descriptor) {
      const missingEnvNames = missingRequiredEnvNames(entry.descriptor, env);
      if (missingEnvNames.length > 0) {
        omitted.push({
          pluginId: entry.id,
          sourceLabel: entry.sourceLabel,
          reason: "missing_env",
          missingEnvNames
        });
        continue;
      }
      const allowedEnv = new Set(entry.descriptor.security.envAllowlist);
      mcpServers.push({
        serverName: entry.descriptor.mcp.serverName,
        command: entry.descriptor.mcp.command,
        args: [...entry.descriptor.mcp.args],
        env: entry.descriptor.mcp.env
          .filter((item) => allowedEnv.has(item.name) && env[item.name] !== undefined)
          .map((item) => ({ name: item.name, value: env[item.name] ?? "" }))
      });
      continue;
    }

    omitted.push({
      pluginId: entry.id,
      sourceLabel: entry.sourceLabel,
      reason: omissionReason(entry),
      missingEnvNames: [...entry.missingEnvNames]
    });
  }

  return { mcpServers, omitted };
}

function discoverDescriptorCandidates(
  config: PluginConfig,
  diagnostics: PluginValidationDiagnostic[]
): DescriptorCandidate[] {
  const candidates: DescriptorCandidate[] = [];

  for (const configuredDir of [...config.pluginDirs].sort()) {
    const root = checkedDirectory(configuredDir, config.deniedRoots, diagnostics);
    if (!root) continue;

    addDescriptorCandidate(root, basename(root), config.deniedRoots, candidates, diagnostics);

    for (const childName of readdirSync(root).sort()) {
      const childPath = join(root, childName);
      const child = checkedDirectory(childPath, config.deniedRoots, diagnostics, true);
      if (!child) continue;
      addDescriptorCandidate(child, `${basename(root)}/${basename(child)}`, config.deniedRoots, candidates, diagnostics);
    }
  }

  return candidates.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function addDescriptorCandidate(
  directory: string,
  label: string,
  deniedRoots: readonly string[],
  candidates: DescriptorCandidate[],
  diagnostics: PluginValidationDiagnostic[]
): void {
  const descriptorPath = join(directory, PLUGIN_DESCRIPTOR_FILENAME);
  if (!existsSync(descriptorPath)) return;

  try {
    const realDescriptorPath = realpathSync(descriptorPath);
    if (isDeniedPath(realDescriptorPath, deniedRoots)) {
      diagnostics.push(diagnostic(descriptorPath, "path_denied", "Plugin descriptor resolves into a denied root"));
      return;
    }
    if (!statSync(realDescriptorPath).isFile()) {
      diagnostics.push(diagnostic(descriptorPath, "invalid_type", "Plugin descriptor path must be a regular file"));
      return;
    }
    candidates.push({
      sourcePath: normalizePath(realDescriptorPath),
      sourceLabel: sanitizeDisplayString(label, 120)
    });
  } catch (error) {
    diagnostics.push(diagnostic(descriptorPath, "read_error", summarizeFsError("Cannot inspect plugin descriptor", error)));
  }
}

function checkedDirectory(
  path: string,
  deniedRoots: readonly string[],
  diagnostics: PluginValidationDiagnostic[],
  optional = false
): string | undefined {
  try {
    if (!existsSync(path)) {
      if (!optional) diagnostics.push(diagnostic(path, "missing", "Configured plugin directory does not exist"));
      return undefined;
    }
    const realPath = realpathSync(path);
    if (isDeniedPath(realPath, deniedRoots)) {
      diagnostics.push(diagnostic(path, "path_denied", "Plugin directory resolves into a denied root"));
      return undefined;
    }
    if (!statSync(realPath).isDirectory()) {
      if (!optional) diagnostics.push(diagnostic(path, "invalid_type", "Configured plugin path must be a directory"));
      return undefined;
    }
    return normalizePath(realPath);
  } catch (error) {
    if (!optional || isSymlink(path)) {
      diagnostics.push(diagnostic(path, "read_error", summarizeFsError("Cannot inspect plugin directory", error)));
    }
    return undefined;
  }
}

function readRegistryEntry(
  candidate: DescriptorCandidate,
  maxDescriptorBytes: number,
  enablement: ReadonlyMap<string, PluginEnablementState>,
  env: Readonly<Record<string, string | undefined>>
): LocalPluginRegistryEntry {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const invalidEntry = (): LocalPluginRegistryEntry => ({
    id: `invalid:${candidate.sourceLabel}`,
    sourcePath: candidate.sourcePath,
    sourceLabel: candidate.sourceLabel,
    enabled: false,
    status: "invalid",
    diagnostics,
    missingEnvNames: []
  });

  try {
    const stat = statSync(candidate.sourcePath);
    if (stat.size > maxDescriptorBytes) {
      diagnostics.push(diagnostic("$", "invalid_argument", `Plugin descriptor exceeds ${maxDescriptorBytes} bytes`));
      return invalidEntry();
    }
    const raw = readFileSync(candidate.sourcePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      diagnostics.push(diagnostic("$", "invalid_json", "Plugin descriptor must contain valid JSON"));
      return invalidEntry();
    }

    const result = validatePluginDescriptor(parsed);
    if (!result.ok) {
      diagnostics.push(...result.diagnostics);
      return invalidEntry();
    }

    const persisted = enablement.get(result.descriptor.id);
    const versionMatches = !persisted?.version || persisted.version === result.descriptor.version;
    const enabled = Boolean(persisted?.enabled && versionMatches);
    const missingEnvNames = enabled ? missingRequiredEnvNames(result.descriptor, env) : [];
    const status =
      persisted?.enabled && !versionMatches ? "version_mismatch" : missingEnvNames.length > 0 ? "missing_env" : "available";

    return {
      id: result.descriptor.id,
      version: result.descriptor.version,
      sourcePath: candidate.sourcePath,
      sourceLabel: candidate.sourceLabel,
      summary: result.summary,
      descriptor: result.descriptor,
      enabled,
      status,
      diagnostics,
      missingEnvNames
    };
  } catch (error) {
    diagnostics.push(diagnostic("$", "read_error", summarizeFsError("Cannot read plugin descriptor", error)));
    return invalidEntry();
  }
}

function applyDuplicateStatus(entries: LocalPluginRegistryEntry[]): void {
  const byId = groupEntries(entries, (entry) => (entry.descriptor ? entry.id : undefined));
  const byServerName = groupEntries(entries, (entry) => entry.descriptor?.mcp.serverName);

  for (const group of [...byId.values(), ...byServerName.values()]) {
    if (group.length < 2) continue;
    for (const entry of group) {
      entry.status = "duplicate";
      entry.enabled = false;
      (entry.diagnostics as PluginValidationDiagnostic[]).push(
        diagnostic("$", "duplicate", "Duplicate plugin id or MCP server name")
      );
    }
  }
}

function groupEntries(
  entries: readonly LocalPluginRegistryEntry[],
  keyForEntry: (entry: LocalPluginRegistryEntry) => string | undefined
): Map<string, LocalPluginRegistryEntry[]> {
  const groups = new Map<string, LocalPluginRegistryEntry[]>();
  for (const entry of entries) {
    const key = keyForEntry(entry);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

function missingRequiredEnvNames(
  descriptor: NonNullable<LocalPluginRegistryEntry["descriptor"]>,
  env: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const allowlist = new Set(descriptor.security.envAllowlist);
  return descriptor.mcp.env
    .filter((item) => item.required && (!allowlist.has(item.name) || !hasEnvValue(env[item.name])))
    .map((item) => item.name)
    .sort();
}

function hasEnvValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function omissionReason(entry: LocalPluginRegistryEntry): PluginProjectionOmission["reason"] {
  if (!entry.enabled && entry.status === "available") return "disabled";
  if (entry.status === "missing_env") return "missing_env";
  if (entry.status === "duplicate") return "duplicate";
  if (entry.status === "version_mismatch") return "version_mismatch";
  return "invalid";
}

function isDeniedPath(path: string, deniedRoots: readonly string[]): boolean {
  const candidate = normalizePath(path);
  return deniedRoots.some((root) => {
    const denied = normalizePath(resolveExistingPath(root));
    return candidate === denied || candidate.startsWith(`${denied}/`);
  });
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
}

function resolveExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function summarizeFsError(prefix: string, error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return `${prefix}: ${error.code}`;
  }
  return prefix;
}
