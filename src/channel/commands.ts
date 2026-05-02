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

  if (command === "tasks") {
    const action = args[0];
    if (action === "list" && args.length === 1) return { command: { kind: "tasks", action } };
    if (action === "add") {
      const scheduleParts = args[1] === "every" ? 2 : looksLikeCronParts(args.slice(1, 6)) ? 5 : 1;
      const schedule = args.slice(1, 1 + scheduleParts).join(" ");
      const label = args[1 + scheduleParts];
      const taskText = args.slice(2 + scheduleParts).join(" ").trim();
      if (!schedule || !label || !taskText) return { error: "usage: /tasks add <schedule> <label> <prompt>" };
      if (!isValidThreadLabel(label)) return { error: "invalid thread label" };
      return { command: { kind: "tasks", action, schedule, label, text: taskText } };
    }
    if (action === "pause" || action === "reactivate" || action === "remove") {
      const taskId = args[1];
      if (args.length !== 2 || !taskId) return { error: `usage: /tasks ${action} <id>` };
      return { command: { kind: "tasks", action, taskId } };
    }
    return { error: "usage: /tasks add|list|pause|reactivate|remove" };
  }

  if (command === "prefs") {
    const action = args[0];
    if (action === "show" && args.length === 1) return { command: { kind: "prefs", action } };
    if (action === "set") {
      const key = readPrefKey(args[1]);
      const value = args.slice(2).join(" ").trim();
      if (!key || !value) return { error: "usage: /prefs set <lang|tone|verbosity> <value>" };
      return { command: { kind: "prefs", action, key, value } };
    }
    if (action === "unset") {
      const key = readPrefKey(args[1]);
      if (!key || args.length !== 2) return { error: "usage: /prefs unset <lang|tone|verbosity>" };
      return { command: { kind: "prefs", action, key } };
    }
    return { error: "usage: /prefs show|set|unset" };
  }

  if (command === "quit" || command === "exit") {
    if (args.length > 0) return { error: `usage: ${rawCommand}` };
    return { command: { kind: "quit" } };
  }

  return { error: `unknown command: ${rawCommand}` };
}

function readPrefKey(value: string | undefined): "lang" | "tone" | "verbosity" | undefined {
  return value === "lang" || value === "tone" || value === "verbosity" ? value : undefined;
}

function looksLikeCronParts(parts: string[]): boolean {
  if (parts.length !== 5) return false;
  return parts.every((part, index) => {
    if (part === "*") return true;
    const parsed = Number.parseInt(part, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== part) return false;
    if (index === 0) return parsed >= 0 && parsed <= 59;
    if (index === 1) return parsed >= 0 && parsed <= 23;
    if (index === 2) return parsed >= 1 && parsed <= 31;
    if (index === 3) return parsed >= 1 && parsed <= 12;
    return parsed >= 0 && parsed <= 6;
  });
}

export function isValidThreadLabel(label: string): boolean {
  return LABEL_PATTERN.test(label);
}
