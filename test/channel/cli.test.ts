import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
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

  test("renders agent deltas inline and statuses on lines", async () => {
    const output = new MemoryWritable();
    const adapter = createCliChannelAdapter({ output });

    await adapter.send({ kind: "status", channel: "cli", userKey: "cli:alice", text: "Turn started." });
    await adapter.send({ kind: "agent_delta", channel: "cli", userKey: "cli:alice", text: "Hi" });
    await adapter.send({ kind: "agent_delta", channel: "cli", userKey: "cli:alice", text: "." });
    await adapter.send({ kind: "agent_delta", channel: "cli", userKey: "cli:alice", text: " What next?" });
    await adapter.send({ kind: "status", channel: "cli", userKey: "cli:alice", text: "Turn completed." });

    expect(output.text()).toBe("Turn started.\nHi. What next?\nTurn completed.\n");
  });

  test("does not print the next prompt until a turn completes", async () => {
    const input = new PassThrough();
    const output = new MemoryWritable();
    const adapter = createCliChannelAdapter({
      input,
      output,
      prompt: "codexclaw> ",
      logger: noopLogger,
      idFactory: () => "message-1"
    });

    const iterator = adapter.receive[Symbol.asyncIterator]();
    input.write("hello\n");
    const next = await iterator.next();
    expect(next.done).toBe(false);
    await delay(5);
    expect(output.text()).toBe("codexclaw> ");

    await adapter.send({ kind: "status", channel: "cli", userKey: "cli:alice", text: "Turn started." });
    await adapter.send({ kind: "agent_delta", channel: "cli", userKey: "cli:alice", text: "Hi." });
    await adapter.send({ kind: "status", channel: "cli", userKey: "cli:alice", text: "Turn completed." });
    await delay(5);

    expect(output.text()).toBe("codexclaw> Turn started.\nHi.\nTurn completed.\ncodexclaw> ");
    adapter.close();
  });

  test("reopens input when a turn needs approval", async () => {
    const input = new PassThrough();
    const output = new MemoryWritable();
    const adapter = createCliChannelAdapter({
      input,
      output,
      prompt: "codexclaw> ",
      logger: noopLogger,
      idFactory: () => "message-1"
    });

    const iterator = adapter.receive[Symbol.asyncIterator]();
    input.write("hello\n");
    await iterator.next();
    await adapter.send({ kind: "status", channel: "cli", userKey: "cli:alice", text: "Turn started." });
    await delay(5);
    expect(output.text()).toBe("codexclaw> Turn started.\n");

    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "cli:alice",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "cli:local"
    });
    await delay(5);

    expect(output.text()).toEndWith("\ncodexclaw> ");
    adapter.close();
  });

  test("accepts approval responses and waits for active turn completion", async () => {
    const input = new PassThrough();
    const output = new MemoryWritable();
    const adapter = createCliChannelAdapter({
      input,
      output,
      prompt: "codexclaw> ",
      logger: noopLogger,
      idFactory: () => "message-1"
    });

    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();
    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "cli:alice",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "cli:local"
    });
    await adapter.send({ kind: "status", channel: "cli", userKey: "cli:alice", text: "Turn started." });

    input.write("/approve approval-1\n");
    const approval = await approvals.next();
    expect(approval.done).toBe(false);
    expect(approval.value).toMatchObject({
      approvalId: "approval-1",
      channelMessageId: "approval-1",
      userKey: "cli:alice",
      decision: "approve",
      channelThreadKey: "cli:local"
    });

    await delay(5);
    expect(output.text()).not.toEndWith("codexclaw> ");
    await adapter.send({ kind: "agent_delta", channel: "cli", userKey: "cli:alice", text: "Done" });
    await adapter.send({ kind: "agent_delta", channel: "cli", userKey: "cli:alice", text: "." });
    await adapter.send({ kind: "status", channel: "cli", userKey: "cli:alice", text: "Turn completed." });
    await delay(5);
    expect(output.text()).toEndWith("Done.\nTurn completed.\ncodexclaw> ");
    adapter.close();
  });

  test("accepts numbered approval shortcuts without approval ids", async () => {
    const input = new PassThrough();
    const output = new MemoryWritable();
    const adapter = createCliChannelAdapter({
      input,
      output,
      prompt: "codexclaw> ",
      logger: noopLogger,
      idFactory: () => "message-1"
    });

    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();
    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "cli:alice",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "cli:local"
    });

    input.write("1\n");
    const approval = await approvals.next();
    expect(approval.done).toBe(false);
    expect(approval.value).toMatchObject({
      approvalId: "approval-1",
      decision: "approve"
    });

    adapter.close();
  });

  test("breaks an open prompt only once when async deltas resume", async () => {
    const input = new PassThrough();
    const output = new MemoryWritable();
    const adapter = createCliChannelAdapter({
      input,
      output,
      prompt: "codexclaw> ",
      logger: noopLogger,
      idFactory: () => "message-1"
    });

    await delay(5);
    await adapter.send({ kind: "agent_delta", channel: "cli", userKey: "cli:alice", text: "완" });
    await adapter.send({ kind: "agent_delta", channel: "cli", userKey: "cli:alice", text: "료" });

    expect(output.text()).toBe("codexclaw> \n완료");
    adapter.close();
  });

  test("accepts numbered modify shortcut with instruction text", async () => {
    const input = new PassThrough();
    const output = new MemoryWritable();
    const adapter = createCliChannelAdapter({
      input,
      output,
      prompt: "codexclaw> ",
      logger: noopLogger,
      idFactory: () => "message-1"
    });

    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();
    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "cli:alice",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "cli:local"
    });

    input.write("3 로컬에서 가능한 방식으로만 진행\n");
    const approval = await approvals.next();
    expect(approval.done).toBe(false);
    expect(approval.value).toMatchObject({
      approvalId: "approval-1",
      decision: "modify",
      modifyText: "로컬에서 가능한 방식으로만 진행"
    });

    adapter.close();
  });
});

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

class MemoryWritable extends Writable {
  private chunks = "";

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks += chunk.toString();
    callback();
  }

  text(): string {
    return this.chunks;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
