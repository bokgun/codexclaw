import type { ChannelCommand } from "./types.js";

export interface ParseCommandResult {
  command?: ChannelCommand;
  error?: string;
}

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseSlashCommand(text: string): ParseCommandResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return {};

  const [rawCommand = "", ...args] = trimmed.split(/\s+/);
  const command = rawCommand.slice(1).toLowerCase();

  if (command === "new") {
    const label = args[0];
    if (args.length > 1) return { error: "usage: /new [label]" };
    if (label && !isValidThreadLabel(label)) return { error: "invalid thread label" };
    return { command: { kind: "new", label } };
  }

  if (command === "threads") {
    if (args.length > 0) return { error: "usage: /threads" };
    return { command: { kind: "threads" } };
  }

  if (command === "switch") {
    const label = args[0];
    if (args.length !== 1 || !label) return { error: "usage: /switch <label>" };
    if (!isValidThreadLabel(label)) return { error: "invalid thread label" };
    return { command: { kind: "switch", label } };
  }

  if (command === "branch") {
    const label = args[0];
    if (args.length > 1) return { error: "usage: /branch [label]" };
    if (label && !isValidThreadLabel(label)) return { error: "invalid thread label" };
    return { command: { kind: "branch", label } };
  }

  if (command === "archive") {
    const label = args[0];
    if (args.length !== 1 || !label) return { error: "usage: /archive <label>" };
    if (!isValidThreadLabel(label)) return { error: "invalid thread label" };
    return { command: { kind: "archive", label } };
  }

  if (command === "quit" || command === "exit") {
    if (args.length > 0) return { error: `usage: ${rawCommand}` };
    return { command: { kind: "quit" } };
  }

  return { error: `unknown command: ${rawCommand}` };
}

export function isValidThreadLabel(label: string): boolean {
  return LABEL_PATTERN.test(label);
}
