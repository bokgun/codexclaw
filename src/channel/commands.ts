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

  if (command === "thread" || command === "threads") {
    return parseThreadCommand(rawCommand, args);
  }

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

  if (command === "wiki") {
    const action = args[0];
    if (action === "ingest") {
      const parsed = parseWikiIngestArgs(args.slice(1));
      if (!parsed) return { error: "usage: /wiki ingest [--public|--private] [--slug <slug>] <path...> [--focus <text>]" };
      return { command: { kind: "wiki", action, ...parsed } };
    }
    if (action === "note") {
      const parsed = parseWikiNoteArgs(args.slice(1));
      if (!parsed) return { error: "usage: /wiki note [--public|--private] <title> <body>" };
      return { command: { kind: "wiki", action, ...parsed } };
    }
    if (action === "capture-selected") {
      const parsed = parseWikiCaptureArgs(args.slice(1));
      if (!parsed) return { error: "usage: /wiki capture-selected [--public|--private] [--slug <slug>] <selected text>" };
      return { command: { kind: "wiki", action, ...parsed } };
    }
    if (action === "query") {
      const parsed = parseWikiQueryArgs(args.slice(1));
      if (!parsed) return { error: "usage: /wiki query [--limit <n>] <query>" };
      return { command: { kind: "wiki", action, ...parsed } };
    }
    if (action === "with") {
      const parsed = parseWikiWithArgs(args.slice(1));
      if (!parsed) return { error: "usage: /wiki with [--limit <n>] <query> -- <message>" };
      return { command: { kind: "wiki", action, ...parsed } };
    }
    if (action === "lint") {
      if (args.length > 2 || (args[1] && args[1] !== "--write-report")) return { error: "usage: /wiki lint [--write-report]" };
      return { command: { kind: "wiki", action, writeReport: args[1] === "--write-report" } };
    }
    return { error: "usage: /wiki ingest|note|capture-selected|query|with|lint" };
  }

  if (command === "quit" || command === "exit") {
    if (args.length > 0) return { error: `usage: ${rawCommand}` };
    return { command: { kind: "quit" } };
  }

  return { error: `unknown command: ${rawCommand}` };
}

function parseThreadCommand(rawCommand: string, args: string[]): ParseCommandResult {
  const action = args[0];
  const rest = args.slice(1);

  if (!action) {
    if (rawCommand === "/threads") return { command: { kind: "threads" } };
    return { error: "usage: /thread list|new|switch|branch|archive" };
  }

  if (action === "list" || action === "ls") {
    if (rest.length > 0) return { error: "usage: /thread list" };
    return { command: { kind: "threads" } };
  }

  if (action === "new") {
    const label = rest[0];
    if (rest.length > 1) return { error: "usage: /thread new [label]" };
    if (label && !isValidThreadLabel(label)) return { error: "invalid thread label" };
    return { command: { kind: "new", label } };
  }

  if (action === "switch") {
    const label = rest[0];
    if (rest.length !== 1 || !label) return { error: "usage: /thread switch <label>" };
    if (!isValidThreadLabel(label)) return { error: "invalid thread label" };
    return { command: { kind: "switch", label } };
  }

  if (action === "branch") {
    const label = rest[0];
    if (rest.length > 1) return { error: "usage: /thread branch [label]" };
    if (label && !isValidThreadLabel(label)) return { error: "invalid thread label" };
    return { command: { kind: "branch", label } };
  }

  if (action === "archive") {
    const label = rest[0];
    if (rest.length !== 1 || !label) return { error: "usage: /thread archive <label>" };
    if (!isValidThreadLabel(label)) return { error: "invalid thread label" };
    return { command: { kind: "archive", label } };
  }

  return { error: "usage: /thread list|new|switch|branch|archive" };
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

function parseWikiIngestArgs(args: string[]):
  | { paths: readonly string[]; visibility: "project_public" | "user_private"; slug?: string; focus?: string }
  | undefined {
  let visibility: "project_public" | "user_private" = "user_private";
  let slug: string | undefined;
  let focus: string | undefined;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--public") {
      visibility = "project_public";
      continue;
    }
    if (arg === "--private") {
      visibility = "user_private";
      continue;
    }
    if (arg === "--slug") {
      slug = args[index + 1];
      index += 1;
      if (!slug || !isValidWikiSlug(slug)) return undefined;
      continue;
    }
    if (arg === "--focus") {
      focus = args.slice(index + 1).join(" ").trim();
      if (!focus) return undefined;
      break;
    }
    if (!arg || arg.startsWith("--")) return undefined;
    paths.push(arg);
  }
  if (paths.length === 0) return undefined;
  return { paths, visibility, slug, focus };
}

function parseWikiNoteArgs(args: string[]):
  | { title: string; body: string; visibility: "project_public" | "user_private" }
  | undefined {
  let visibility: "project_public" | "user_private" = "user_private";
  const rest = [...args];
  while (rest[0] === "--public" || rest[0] === "--private") {
    visibility = rest.shift() === "--public" ? "project_public" : "user_private";
  }
  const title = rest.shift();
  const body = rest.join(" ").trim();
  if (!title || !body) return undefined;
  return { title, body, visibility };
}

function parseWikiCaptureArgs(args: string[]):
  | { text: string; visibility: "project_public" | "user_private"; slug?: string }
  | undefined {
  let visibility: "project_public" | "user_private" = "user_private";
  let slug: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--public") {
      visibility = "project_public";
      continue;
    }
    if (arg === "--private") {
      visibility = "user_private";
      continue;
    }
    if (arg === "--slug") {
      slug = args[index + 1];
      index += 1;
      if (!slug || !isValidWikiSlug(slug)) return undefined;
      continue;
    }
    rest.push(arg);
  }
  const text = rest.join(" ").trim();
  if (!text) return undefined;
  return { text, visibility, slug };
}

function parseWikiQueryArgs(args: string[]): { query: string; limit?: number } | undefined {
  let limit: number | undefined;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      index += 1;
      if (!Number.isInteger(value) || value < 1 || value > 20) return undefined;
      limit = value;
      continue;
    }
    rest.push(arg);
  }
  const query = rest.join(" ").trim();
  if (!query) return undefined;
  return { query, limit };
}

function parseWikiWithArgs(args: string[]): { query: string; message: string; limit?: number } | undefined {
  const separator = args.indexOf("--");
  if (separator <= 0 || separator === args.length - 1) return undefined;
  const query = parseWikiQueryArgs(args.slice(0, separator));
  const message = args.slice(separator + 1).join(" ").trim();
  if (!query || !message) return undefined;
  return { ...query, message };
}

function isValidWikiSlug(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(slug) && !slug.includes("..");
}
