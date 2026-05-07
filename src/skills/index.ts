import { CodexSkillInspector, sanitizeDisplayText, type CodexSkillSummary } from "./codex-skills.js";
import { listHostSkills, type HostSkillRegistryOptions, type HostSkillSummary } from "./host-registry.js";
import type { CodexRuntimeClient } from "../codex/runtime-client.js";

export type { CodexSkillSummary, CodexSkillsClient, CodexSkillsSnapshot, SkillFamily } from "./codex-skills.js";
export type { HostSkillRegistryOptions, HostSkillSummary } from "./host-registry.js";

export interface UnifiedSkillSummary {
  family: "codex" | "host";
  name: string;
  scope: string;
  enabled: boolean;
  sourceLabel: string;
  description: string;
  errors: readonly string[];
}

export interface SkillOutputPolicy {
  maxItems: number;
  maxErrorChars: number;
  maxOutputChars: number;
}

export interface SkillInspectionService {
  invalidateCodexSkills(): void;
  listUnifiedSkills(options?: { forceReload?: boolean }): Promise<{
    skills: readonly UnifiedSkillSummary[];
    errors: readonly string[];
    truncated: number;
  }>;
  renderSkillList(options?: { forceReload?: boolean }): Promise<string>;
}

export interface SkillInspectionServiceOptions extends HostSkillRegistryOptions {
  workspaceRoot: string;
  outputPolicy?: Partial<SkillOutputPolicy>;
}

const DEFAULT_POLICY: SkillOutputPolicy = {
  maxItems: 30,
  maxErrorChars: 180,
  maxOutputChars: 3_500
};

export function createSkillInspectionService(
  codex: Pick<CodexRuntimeClient, "listSkills">,
  options: SkillInspectionServiceOptions
): SkillInspectionService {
  const policy = { ...DEFAULT_POLICY, ...options.outputPolicy };
  const codexSkills = new CodexSkillInspector(codex, {
    workspaceRoot: options.workspaceRoot,
    maxErrorChars: policy.maxErrorChars
  });

  return {
    invalidateCodexSkills(): void {
      codexSkills.invalidate();
    },

    async listUnifiedSkills(listOptions = {}) {
      const host = listHostSkills(options).map(fromHostSkill);
      let codex: UnifiedSkillSummary[] = [];
      const errors: string[] = [];

      try {
        const snapshot = await codexSkills.list(listOptions);
        codex = snapshot.summaries.map(fromCodexSkill);
        errors.push(...snapshot.errors.map((error) => sanitizeDisplayText(error, policy.maxErrorChars)));
      } catch (error) {
        errors.push(`Codex skills unavailable: ${boundedError(error, policy.maxErrorChars)}`);
      }

      const sorted = [...codex, ...host].sort(compareSkill);
      const visible = sorted.slice(0, policy.maxItems);
      return {
        skills: visible,
        errors,
        truncated: Math.max(0, sorted.length - visible.length)
      };
    },

    async renderSkillList(listOptions = {}) {
      const result = await this.listUnifiedSkills(listOptions);
      return renderUnifiedSkillList(result, policy);
    }
  };
}

export function renderUnifiedSkillList(
  result: { skills: readonly UnifiedSkillSummary[]; errors: readonly string[]; truncated: number },
  policy: SkillOutputPolicy = DEFAULT_POLICY
): string {
  const lines = ["Skills (read-only)"];
  for (const skill of result.skills) {
    const state = skill.enabled ? "enabled" : "disabled";
    const description = skill.description ? ` - ${sanitizeDisplayText(skill.description, 160)}` : "";
    lines.push(`- [${skill.family}/${skill.scope}/${state}] ${skill.name}${description} (${skill.sourceLabel})`);
    const errors = skill.errors.slice(0, 2).map((error) => sanitizeDisplayText(error, policy.maxErrorChars));
    if (errors.length > 0) lines.push(`  errors: ${errors.join("; ")}`);
  }

  if (result.truncated > 0) lines.push(`... ${result.truncated} more not shown.`);
  for (const error of result.errors.slice(0, 3)) {
    lines.push(`! ${sanitizeDisplayText(error, policy.maxErrorChars)}`);
  }

  const rendered = lines.join("\n");
  if (rendered.length <= policy.maxOutputChars) return rendered;
  return `${rendered.slice(0, Math.max(0, policy.maxOutputChars - 24)).trimEnd()}\n... output truncated.`;
}

function fromCodexSkill(skill: CodexSkillSummary): UnifiedSkillSummary {
  return {
    family: "codex",
    name: skill.name,
    scope: skill.scope,
    enabled: skill.enabled,
    sourceLabel: skill.sourceLabel,
    description: skill.description,
    errors: skill.errors
  };
}

function fromHostSkill(skill: HostSkillSummary): UnifiedSkillSummary {
  return {
    family: "host",
    name: skill.name,
    scope: skill.scope,
    enabled: skill.enabled,
    sourceLabel: `${skill.sourceLabel}; ${skill.boundary}`,
    description: skill.description,
    errors: skill.errors
  };
}

function compareSkill(a: UnifiedSkillSummary, b: UnifiedSkillSummary): number {
  return (
    a.family.localeCompare(b.family) ||
    a.scope.localeCompare(b.scope) ||
    a.name.localeCompare(b.name)
  );
}

function boundedError(error: unknown, maxChars: number): string {
  if (error instanceof Error) return sanitizeDisplayText(error.name || "Error", maxChars);
  return sanitizeDisplayText(String(error), maxChars);
}
