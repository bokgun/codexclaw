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
});
