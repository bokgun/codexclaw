import { describe, expect, test } from "bun:test";
import { createCliChannelAdapter } from "../../src/channel/cli.js";

describe("CliChannelAdapter", () => {
  test("normalizes user input with stable CLI routing fields", () => {
    let nextId = 0;
    const adapter = createCliChannelAdapter({
      userKey: "cli:alice",
      channelThreadKey: "cli:local",
      now: () => new Date("2026-05-01T00:00:00.000Z"),
      idFactory: () => `message-${++nextId}`
    });

    expect(adapter.parseInput("hello")).toEqual({
      kind: "message",
      message: {
        id: "message-1",
        userKey: "cli:alice",
        channel: "cli",
        text: "hello",
        receivedAt: "2026-05-01T00:00:00.000Z",
        channelThreadKey: "cli:local"
      }
    });
  });

  test("keeps slash commands at the adapter/router edge", () => {
    const adapter = createCliChannelAdapter({ userKey: "cli:alice" });

    expect(adapter.parseInput("/switch work")).toEqual({
      kind: "command",
      command: { kind: "switch", label: "work" }
    });
  });
});
