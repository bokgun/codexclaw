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

  test("rejects invalid labels and unknown commands", () => {
    expect(parseSlashCommand("/switch ../bad").error).toBe("invalid thread label");
    expect(parseSlashCommand("/archive").error).toBe("usage: /archive <label>");
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
});
