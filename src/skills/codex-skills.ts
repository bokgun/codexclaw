import { relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { CodexRuntimeClient, SkillsListResponse } from "../codex/runtime-client.js";

export type SkillFamily = "codex" | "host";
export type SkillScope = "user" | "repo" | "system" | "admin";
export type CodexSkillScope = SkillScope | "unknown";

interface SkillsListEntry {
  cwd: string;
  skills: SkillMetadata[];
  errors: Array<{ path: string; message: string }>;
}

interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    defaultPrompt?: string;
  };
  dependencies?: unknown;
  path: string;
  scope: SkillScope;
  enabled: boolean;
}

export interface CodexSkillSummary {
  family: "codex";
  name: string;
  description: string;
  scope: CodexSkillScope;
  enabled: boolean;
  sourceLabel: string;
  cwdLabel: string;
  errors: readonly string[];
}

export interface CodexSkillsSnapshot {
  summaries: readonly CodexSkillSummary[];
  errors: readonly string[];
  fromCache: boolean;
}

export interface CodexSkillsClient {
  listSkills(params: { cwds: string[]; forceReload?: boolean }): Promise<SkillsListResponse>;
}

export interface CodexSkillInspectorOptions {
  workspaceRoot: string;
  maxErrorChars?: number;
}

export class CodexSkillInspector {
  private cache?: { summaries: readonly CodexSkillSummary[]; errors: readonly string[] };
  private invalidated = true;
  private readonly workspaceRoot: string;
  private readonly maxErrorChars: number;

  constructor(
    private readonly codex: Pick<CodexRuntimeClient, "listSkills"> | CodexSkillsClient,
    options: CodexSkillInspectorOptions
  ) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.maxErrorChars = options.maxErrorChars ?? 180;
  }

  invalidate(): void {
    this.invalidated = true;
  }

  async list(options: { forceReload?: boolean } = {}): Promise<CodexSkillsSnapshot> {
    if (this.cache && !this.invalidated && !options.forceReload) {
      return { ...this.cache, fromCache: true };
    }

    const response = await this.codex.listSkills({
      cwds: [this.workspaceRoot],
      forceReload: options.forceReload || this.invalidated ? true : undefined
    });
    const normalized = normalizeCodexSkillsResponse(response, {
      workspaceRoot: this.workspaceRoot,
      maxErrorChars: this.maxErrorChars
    });
    this.cache = normalized;
    this.invalidated = false;
    return { ...normalized, fromCache: false };
  }
}

export function normalizeCodexSkillsResponse(
  response: SkillsListResponse,
  options: { workspaceRoot: string; maxErrorChars?: number }
): { summaries: readonly CodexSkillSummary[]; errors: readonly string[] } {
  const maxErrorChars = options.maxErrorChars ?? 180;
  const summaries: CodexSkillSummary[] = [];
  const errors: string[] = [];

  for (const entry of Array.isArray(response.data) ? response.data : []) {
    const entryErrors = normalizeEntryErrors(entry, options.workspaceRoot, maxErrorChars);
    errors.push(...entryErrors);
    for (const skill of Array.isArray(entry.skills) ? entry.skills : []) {
      summaries.push(normalizeSkill(skill, entry, entryErrors, options.workspaceRoot));
    }
  }

  return { summaries, errors };
}

export function renderSkillPath(path: string | null | undefined, workspaceRoot: string): string {
  if (!path) return "unknown";
  const normalized = resolve(path);
  const workspace = resolve(workspaceRoot);
  const workspaceRel = relative(workspace, normalized);
  if (workspaceRel === "") return ".";
  if (workspaceRel && !workspaceRel.startsWith("..") && !workspaceRel.startsWith("/") && workspaceRel !== "..") {
    return shortenPath(workspaceRel);
  }

  const home = resolve(homedir());
  const homeRel = relative(home, normalized);
  if (homeRel === "") return "~";
  if (homeRel && !homeRel.startsWith("..") && !homeRel.startsWith("/") && homeRel !== "..") {
    return shortenPath(`~/${homeRel}`);
  }

  return "[redacted]";
}

export function renderSkillSourceLabel(path: string | null | undefined, workspaceRoot: string): string {
  return sanitizeDisplayText(redactSensitiveText(renderSkillPath(path, workspaceRoot), workspaceRoot), 96);
}

export function sanitizeDisplayText(value: string | null | undefined, maxChars: number): string {
  const cleaned = (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/@(everyone|here)\b/gi, "[at]$1")
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, "[mention]")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

export function sanitizeSkillText(value: string | null | undefined, maxChars: number, workspaceRoot: string): string {
  return sanitizeDisplayText(redactSensitiveText(value ?? "", workspaceRoot), maxChars);
}

function normalizeSkill(
  skill: SkillMetadata,
  entry: SkillsListEntry,
  entryErrors: readonly string[],
  workspaceRoot: string
): CodexSkillSummary {
  return {
    family: "codex",
    name: sanitizeSkillText(skill.interface?.displayName || skill.name, 80, workspaceRoot) || "unnamed",
    description: sanitizeSkillText(skill.interface?.shortDescription || skill.shortDescription || skill.description, 220, workspaceRoot),
    scope: normalizeSkillScope(skill.scope),
    enabled: Boolean(skill.enabled),
    sourceLabel: renderSkillSourceLabel(skill.path, workspaceRoot),
    cwdLabel: renderSkillSourceLabel(entry.cwd, workspaceRoot),
    errors: []
  };
}

function normalizeEntryErrors(entry: SkillsListEntry, workspaceRoot: string, maxErrorChars: number): string[] {
  return (Array.isArray(entry.errors) ? entry.errors : []).map((error) => {
    const path = renderSkillSourceLabel(error.path, workspaceRoot);
    const message = sanitizeDisplayText(error.message ? "skill metadata error details omitted" : "", maxErrorChars);
    return message ? `${path}: ${message}` : path;
  });
}

function redactSensitiveText(value: string, workspaceRoot: string): string {
  const workspace = resolve(workspaceRoot).replace(/\\/g, "/");
  const home = resolve(homedir()).replace(/\\/g, "/");
  let redacted = value.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s)>\]}]+/g, "[url redacted]");
  redacted = replacePathPrefix(redacted, workspace, workspaceRoot);
  redacted = replacePathPrefix(redacted, home, workspaceRoot);
  redacted = redacted.replace(/(^|[^A-Za-z0-9_.-])\/[^\s)>\]}]+/g, "$1[path redacted]");
  redacted = redacted.replace(/(^|[^A-Za-z0-9_.-])[A-Za-z]:[\\/][^\s)>\]}]+/g, "$1[path redacted]");
  return redacted;
}

function normalizeSkillScope(scope: string): CodexSkillScope {
  return scope === "user" || scope === "repo" || scope === "system" || scope === "admin" ? scope : "unknown";
}

function replacePathPrefix(value: string, prefix: string, workspaceRoot: string): string {
  if (!prefix || prefix === "/") return value;
  const escaped = escapeRegExp(prefix);
  return value.replace(new RegExp(`${escaped}(?=$|/)(?:/[^\\s)>\\]}]+)*`, "g"), (match) =>
    renderSkillPath(match.replace(/\//g, "/"), workspaceRoot)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortenPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.length <= 96) return normalized;
  const parts = normalized.split("/");
  if (parts.length <= 2) return `...${normalized.slice(-93)}`;
  const tail = parts.slice(-3).join("/");
  return `.../${tail}`.slice(0, 96);
}
