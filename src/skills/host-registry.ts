import type { ChannelName } from "../runtime/types.js";

export interface HostSkillSummary {
  family: "host";
  name: string;
  scope: "host" | "channel" | "wiki" | "scheduler" | "installer";
  enabled: boolean;
  sourceLabel: string;
  description: string;
  boundary: "metadata_only";
  errors: readonly string[];
}

export interface HostSkillRegistryOptions {
  activeChannel?: ChannelName;
  schedulerEnabled?: boolean;
  wikiEnabled?: boolean;
}

export function listHostSkills(options: HostSkillRegistryOptions = {}): readonly HostSkillSummary[] {
  return [
    hostSkill("codexclaw-runtime", "host", true, "host", "Runtime routing, pointers, approvals transport, and reconnect metadata."),
    hostSkill("cli", "channel", options.activeChannel === "cli", "channel", "CLI channel adapter."),
    hostSkill("telegram", "channel", options.activeChannel === "telegram", "channel", "Telegram channel adapter."),
    hostSkill("discord", "channel", options.activeChannel === "discord", "channel", "Discord channel adapter."),
    hostSkill("scheduler", "scheduler", Boolean(options.schedulerEnabled), "scheduler", "Scheduled prompt routing metadata."),
    hostSkill("wiki", "wiki", Boolean(options.wikiEnabled), "wiki", "Read/write wiki context commands for user-managed knowledge."),
    hostSkill("skill-installer", "installer", false, "installer", "Installer placeholder. Installation is outside the M4c read-only surface.")
  ];
}

function hostSkill(
  name: string,
  scope: HostSkillSummary["scope"],
  enabled: boolean,
  sourceLabel: string,
  description: string
): HostSkillSummary {
  return {
    family: "host",
    name,
    scope,
    enabled,
    sourceLabel,
    description,
    boundary: "metadata_only",
    errors: []
  };
}
