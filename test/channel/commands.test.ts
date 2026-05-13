import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "../../src/channel/commands.js";

describe("parseSlashCommand", () => {
  test("parses M1 thread commands", () => {
    expect(parseSlashCommand("/new work").command).toEqual({ kind: "new", label: "work" });
    expect(parseSlashCommand("/threads").command).toEqual({ kind: "threads" });
    expect(parseSlashCommand("/switch default").command).toEqual({ kind: "switch", label: "default" });
    expect(parseSlashCommand("/branch fix.1").command).toEqual({ kind: "branch", label: "fix.1" });
    expect(parseSlashCommand("/archive old").command).toEqual({ kind: "archive", label: "old" });
  });

  test("parses explicit thread namespace commands", () => {
    expect(parseSlashCommand("/thread list").command).toEqual({ kind: "threads" });
    expect(parseSlashCommand("/thread ls").command).toEqual({ kind: "threads" });
    expect(parseSlashCommand("/thread new work").command).toEqual({ kind: "new", label: "work" });
    expect(parseSlashCommand("/thread new").command).toEqual({ kind: "new", label: undefined });
    expect(parseSlashCommand("/thread switch default").command).toEqual({ kind: "switch", label: "default" });
    expect(parseSlashCommand("/thread branch fix.1").command).toEqual({ kind: "branch", label: "fix.1" });
    expect(parseSlashCommand("/thread archive old").command).toEqual({ kind: "archive", label: "old" });
  });

  test("rejects invalid labels and unknown commands", () => {
    expect(parseSlashCommand("/switch ../bad").error).toBe("invalid thread label");
    expect(parseSlashCommand("/thread switch ../bad").error).toBe("invalid thread label");
    expect(parseSlashCommand("/archive").error).toBe("usage: /archive <label>");
    expect(parseSlashCommand("/thread nope").error).toBe("usage: /thread list|new|switch|branch|archive");
    expect(parseSlashCommand("/nope").error).toBe("unknown command: /nope");
  });

  test("leaves normal messages unparsed", () => {
    expect(parseSlashCommand("hello")).toEqual({});
  });

  test("parses task and prefs commands", () => {
    expect(parseSlashCommand("/tasks add every 5m ops check status").command).toEqual({
      kind: "tasks",
      action: "add",
      schedule: "every 5m",
      label: "ops",
      text: "check status"
    });
    expect(parseSlashCommand("/tasks pause task-1").command).toEqual({ kind: "tasks", action: "pause", taskId: "task-1" });
    expect(parseSlashCommand("/tasks add 0 * * * * ops check status").command).toEqual({
      kind: "tasks",
      action: "add",
      schedule: "0 * * * *",
      label: "ops",
      text: "check status"
    });
    expect(parseSlashCommand("/prefs set tone concise").command).toEqual({
      kind: "prefs",
      action: "set",
      key: "tone",
      value: "concise"
    });
    expect(parseSlashCommand("/prefs unset lang").command).toEqual({ kind: "prefs", action: "unset", key: "lang" });
  });

  test("parses wiki commands", () => {
    expect(parseSlashCommand("/wiki ingest --public --slug project docs/ROADMAP.md README.md").command).toEqual({
      kind: "wiki",
      action: "ingest",
      paths: ["docs/ROADMAP.md", "README.md"],
      visibility: "project_public",
      slug: "project",
      focus: undefined
    });
    expect(parseSlashCommand("/wiki ingest README.md --focus runtime design").command).toEqual({
      kind: "wiki",
      action: "ingest",
      paths: ["README.md"],
      visibility: "user_private",
      slug: undefined,
      focus: "runtime design"
    });
    expect(parseSlashCommand("/wiki note decision Use markdown wiki").command).toEqual({
      kind: "wiki",
      action: "note",
      title: "decision",
      body: "Use markdown wiki",
      visibility: "user_private"
    });
    expect(parseSlashCommand("/wiki capture-selected --slug today selected summary").command).toEqual({
      kind: "wiki",
      action: "capture-selected",
      text: "selected summary",
      visibility: "user_private",
      slug: "today"
    });
    expect(parseSlashCommand("/wiki query --limit 3 router design").command).toEqual({
      kind: "wiki",
      action: "query",
      query: "router design",
      limit: 3
    });
    expect(parseSlashCommand("/wiki with --limit 2 router design -- explain it").command).toEqual({
      kind: "wiki",
      action: "with",
      query: "router design",
      message: "explain it",
      limit: 2
    });
    expect(parseSlashCommand("/wiki lint --write-report").command).toEqual({
      kind: "wiki",
      action: "lint",
      writeReport: true
    });
  });

  test("rejects malformed wiki commands", () => {
    expect(parseSlashCommand("/wiki ingest").error).toBe("usage: /wiki ingest [--public|--private] [--slug <slug>] <path...> [--focus <text>]");
    expect(parseSlashCommand("/wiki query --limit 100 x").error).toBe("usage: /wiki query [--limit <n>] <query>");
    expect(parseSlashCommand("/wiki nope").error).toBe("usage: /wiki ingest|note|capture-selected|query|with|lint");
  });

  test("parses read-only skills inspection command and rejects skill execution shapes", () => {
    expect(parseSlashCommand("/skills list").command).toEqual({ kind: "skills", action: "list" });
    expect(parseSlashCommand("/skills use review").error).toBe("usage: /skills list");
    expect(parseSlashCommand("/skill review").error).toBe("usage: /skills list");
  });

  test("parses plugin inspection and enablement command shapes", () => {
    expect(parseSlashCommand("/plugin list").command).toEqual({ kind: "plugin", action: "list" });
    expect(parseSlashCommand("/plugin status opencandle").command).toEqual({
      kind: "plugin",
      action: "status",
      pluginId: "opencandle"
    });
    expect(parseSlashCommand("/plugin enable opencandle").command).toEqual({
      kind: "plugin",
      action: "enable",
      pluginId: "opencandle",
      confirm: false
    });
    expect(parseSlashCommand("/plugin enable opencandle --confirm").command).toEqual({
      kind: "plugin",
      action: "enable",
      pluginId: "opencandle",
      confirm: true
    });
    expect(parseSlashCommand("/plugin disable opencandle").command).toEqual({
      kind: "plugin",
      action: "disable",
      pluginId: "opencandle"
    });
  });

  test("rejects malformed plugin commands", () => {
    expect(parseSlashCommand("/plugin").error).toBe("usage: /plugin list|status|enable|disable");
    expect(parseSlashCommand("/plugin install opencandle").error).toBe("usage: /plugin list|status|enable|disable");
    expect(parseSlashCommand("/plugin list opencandle").error).toBe("usage: /plugin list");
    expect(parseSlashCommand("/plugin status").error).toBe("usage: /plugin status <id>");
    expect(parseSlashCommand("/plugin status opencandle extra").error).toBe("usage: /plugin status <id>");
    expect(parseSlashCommand("/plugin enable").error).toBe("usage: /plugin enable <id> [--confirm]");
    expect(parseSlashCommand("/plugin enable opencandle --now").error).toBe("usage: /plugin enable <id> [--confirm]");
    expect(parseSlashCommand("/plugin enable opencandle --confirm extra").error).toBe("usage: /plugin enable <id> [--confirm]");
    expect(parseSlashCommand("/plugin enable --confirm opencandle").error).toBe("invalid plugin id");
    expect(parseSlashCommand("/plugin disable").error).toBe("usage: /plugin disable <id>");
    expect(parseSlashCommand("/plugin disable opencandle extra").error).toBe("usage: /plugin disable <id>");
    expect(parseSlashCommand("/plugin status ../bad").error).toBe("invalid plugin id");
    expect(parseSlashCommand("/plugin status OpenCandle").error).toBe("invalid plugin id");
  });
});
