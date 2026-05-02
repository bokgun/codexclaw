import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  DiscordChannelAdapter,
  DiscordFetchApiClient,
  verifyDiscordInteractionSignature,
  type DiscordApiClient,
  type DiscordInteraction,
  type DiscordInteractionCallbackResponse,
  type DiscordChannel,
  type DiscordMessage,
  type DiscordSendMessageParams,
  type DiscordWebhookMessageParams
} from "../../src/channel/discord.js";
import type { DiscordConfig } from "../../src/config/env.js";

describe("DiscordChannelAdapter", () => {
  test("normalizes allowed DM text into channel-neutral prompt messages", async () => {
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api);
    const iterator = adapter.receive[Symbol.asyncIterator]();

    await adapter.processGatewayMessage({
      id: "m1",
      channel_id: "100",
      content: "hello",
      author: { id: "42" },
      timestamp: "2026-05-01T00:00:00.000Z"
    });
    const next = await iterator.next();

    expect(next.value).toEqual({
      id: "discord:100:m1",
      userKey: "discord:42",
      channel: "discord",
      text: "hello",
      receivedAt: "2026-05-01T00:00:00.000Z",
      channelThreadKey: "discord:100",
      replyToMessageId: undefined
    });
    await adapter.close();
  });

  test("routes guild mention text but ignores unmentioned guild chatter", async () => {
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api);
    const iterator = adapter.receive[Symbol.asyncIterator]();

    await adapter.processGatewayMessage({
      id: "m1",
      channel_id: "100",
      guild_id: "900",
      content: "hello room",
      author: { id: "42" }
    });
    await adapter.processGatewayMessage({
      id: "m2",
      channel_id: "100",
      guild_id: "900",
      content: "<@123456> hello bot",
      author: { id: "42" }
    });

    const next = await iterator.next();
    expect(next.value?.text).toBe("hello bot");
    expect(next.value?.userKey).toBe("discord:42");
    await adapter.close();
  });

  test("rejects gateway slash-looking text instead of routing commands", async () => {
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api);
    const iterator = adapter.receive[Symbol.asyncIterator]();

    await adapter.processGatewayMessage({
      id: "m1",
      channel_id: "100",
      content: "/threads",
      author: { id: "42" }
    });
    const routed = await Promise.race([iterator.next(), delay(10).then(() => "none" as const)]);

    expect(routed).toBe("none");
    expect(api.sent.map((message) => message.content)).toEqual([
      "Use Discord slash commands for codexclaw commands. Gateway text is treated as prompt text only."
    ]);
    await adapter.close();
  });

  test("normalizes signed slash command interactions as executable command text", async () => {
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api);
    const iterator = adapter.receive[Symbol.asyncIterator]();

    await adapter.processInteraction(interaction({
      type: 2,
      id: "i1",
      userId: "42",
      channelId: "100",
      data: { name: "switch", options: [{ name: "label", type: 3, value: "work" }] }
    }));
    const next = await iterator.next();

    expect(api.callbacks).toEqual([{ id: "i1", token: "token-i1", response: { type: 5, data: { flags: 64 } } }]);
    expect(next.value).toMatchObject({
      id: "discord:interaction:i1",
      userKey: "discord:42",
      channel: "discord",
      text: "/switch work",
      channelThreadKey: "discord:100"
    });
    await adapter.close();
  });

  test("coalesces deltas and chunks long outbound messages", async () => {
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api, { deltaFlushMs: 10_000 });

    await adapter.send({ kind: "agent_delta", channel: "discord", userKey: "discord:42", channelThreadKey: "discord:100", text: "Hel" });
    await adapter.send({ kind: "agent_delta", channel: "discord", userKey: "discord:42", channelThreadKey: "discord:100", text: "lo" });
    await adapter.send({ kind: "text", channel: "discord", userKey: "discord:42", channelThreadKey: "discord:100", text: "x".repeat(4100) });

    expect(api.sent[0]?.content).toBe("Hello");
    expect(api.sent.slice(1)).toHaveLength(3);
    expect(api.sent.every((message) => message.content.length <= 1900)).toBe(true);
    await adapter.close();
  });

  test("sends approval buttons and verifies approve component callbacks", async () => {
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    const prompt = await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "discord:42",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "discord:100"
    });
    await adapter.processInteraction(interaction({
      type: 3,
      id: "i2",
      userId: "42",
      channelId: "100",
      messageId: "1",
      data: { custom_id: "cc:a:k1:approve" }
    }));
    const approval = await approvals.next();

    expect(prompt).toEqual({ approvalId: "approval-1", channelMessageId: "discord:100:1" });
    expect(api.sent[0]?.components?.[0]?.components.map((button) => ("custom_id" in button ? button.custom_id : ""))).toEqual([
      "cc:a:k1:approve",
      "cc:a:k1:reject",
      "cc:a:k1:modify"
    ]);
    expect(approval.value).toMatchObject({
      approvalId: "approval-1",
      userKey: "discord:42",
      decision: "approve",
      channelThreadKey: "discord:100"
    });
    expect(api.callbacks.at(-1)?.response).toEqual({ type: 4, data: { content: "Approved.", flags: 64 } });
    await adapter.close();
  });

  test("maps Modify button to reject-style response plus modal follow-up text", async () => {
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "discord:42",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "discord:100"
    });
    await adapter.processInteraction(interaction({
      type: 3,
      id: "i2",
      userId: "42",
      channelId: "100",
      messageId: "1",
      data: { custom_id: "cc:a:k1:modify" }
    }));
    const beginModify = await approvals.next();
    await adapter.processInteraction(interaction({
      type: 5,
      id: "i3",
      userId: "42",
      channelId: "100",
      data: {
        custom_id: "cc:m:k1",
        components: [{ type: 1, components: [{ type: 4, custom_id: "modify_text", value: "Use safer command" }] }]
      } as never
    }));
    const completeModify = await approvals.next();

    expect(beginModify.value).toMatchObject({ approvalId: "approval-1", decision: "modify", modifyText: undefined });
    expect(api.callbacks.find((callback) => callback.id === "i2")?.response.type).toBe(9);
    expect(completeModify.value).toMatchObject({
      approvalId: "approval-1",
      decision: "modify",
      modifyText: "Use safer command"
    });
    await adapter.close();
  });

  test("exposes branch suggestion button responses", async () => {
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api);
    const responses = adapter.branchSuggestionResponses[Symbol.asyncIterator]();

    await adapter.requestBranchSuggestion({
      suggestionId: "suggestion-1",
      userKey: "discord:42",
      channelThreadKey: "discord:100",
      text: "Start new thread?",
      expiresAt: "2026-05-01T00:05:00.000Z",
      options: ["new_thread", "continue"]
    });
    await adapter.processInteraction(interaction({
      type: 3,
      id: "i2",
      userId: "42",
      channelId: "100",
      messageId: "1",
      data: { custom_id: "cc:b:k1:continue" }
    }));
    const response = await responses.next();

    expect(response.value).toEqual({
      suggestionId: "suggestion-1",
      userKey: "discord:42",
      channelThreadKey: "discord:100",
      decision: "continue",
      receivedAt: "2026-05-01T00:00:00.000Z"
    });
    await adapter.close();
  });

  test("verifies Discord Ed25519 interaction signatures over timestamp plus raw body", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const body = Buffer.from(JSON.stringify({ type: 1 }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signatureHex = sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString("hex");
    const publicKeyHex = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("hex");

    expect(verifyDiscordInteractionSignature({ publicKeyHex, timestamp, body, signatureHex })).toBe(true);
    expect(verifyDiscordInteractionSignature({ publicKeyHex, timestamp, body: Buffer.from("{}"), signatureHex })).toBe(false);
    expect(
      verifyDiscordInteractionSignature({
        publicKeyHex,
        timestamp: "1",
        body,
        signatureHex,
        now: new Date()
      })
    ).toBe(false);
  });

  test("rejects replayed signed HTTP interactions", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyHex = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32).toString("hex");
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api, { publicKey: publicKeyHex });
    const body = JSON.stringify(interaction({ type: 2, id: "replay-1", userId: "42", channelId: "100", data: { name: "threads" } }));
    const timestamp = String(Math.floor(new Date("2026-05-01T00:00:00.000Z").getTime() / 1000));
    const signature = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), privateKey).toString("hex");
    const request = () =>
      new Request("http://127.0.0.1/discord/interactions", {
        method: "POST",
        headers: {
          "x-signature-timestamp": timestamp,
          "x-signature-ed25519": signature,
          "content-length": String(Buffer.byteLength(body))
        },
        body
      });

    expect((await adapter.handleInteractionRequest(request())).status).toBe(204);
    expect((await adapter.handleInteractionRequest(request())).status).toBe(409);
    await adapter.close();
  });

  test("uses Discord DM channels when no live channel target is available", async () => {
    const api = new FakeDiscordApi();
    const adapter = adapterWith(api);

    await adapter.send({ kind: "text", channel: "discord", userKey: "discord:42", text: "scheduled notice" });

    expect(api.dmChannels).toEqual(["42"]);
    expect(api.sent.at(-1)).toMatchObject({ channel_id: "dm-42", content: "scheduled notice" });
    await adapter.close();
  });

  test("redacts bot tokens from fetch-level Discord errors", async () => {
    const client = new DiscordFetchApiClient({
      botToken: "secret-token",
      fetch: (() => {
        throw new Error("Authorization failed for Bot secret-token");
      }) as typeof fetch
    });

    await expect(client.sendMessage({ channel_id: "100", content: "hi" })).rejects.toThrow("[discord-bot-token]");
    await expect(client.sendMessage({ channel_id: "100", content: "hi" })).rejects.not.toThrow("secret-token");
  });
});

function adapterWith(api: FakeDiscordApi, overrides: Partial<DiscordConfig> = {}, key = "k1"): DiscordChannelAdapter {
  return new DiscordChannelAdapter({
    config: discordConfig(overrides),
    apiClient: api,
    now: () => new Date("2026-05-01T00:00:00.000Z"),
    keyFactory: () => key,
    startInteractionServer: false
  });
}

function discordConfig(overrides: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    botToken: "secret-token",
    applicationId: "123456",
    publicKey: "a".repeat(64),
    allowedUserIds: ["42"],
    allowAllUsersForLocalDev: false,
    allowedGuildIds: [],
    apiBaseUrl: "https://discord.com/api/v10",
    interactionsHost: "127.0.0.1",
    interactionsPort: 8787,
    interactionsPath: "/discord/interactions",
    gatewayUrl: undefined,
    modifyTimeoutMs: 60_000,
    deltaFlushMs: 750,
    ...overrides
  };
}

class FakeDiscordApi implements DiscordApiClient {
  readonly sent: DiscordSendMessageParams[] = [];
  readonly callbacks: Array<{ id: string; token: string; response: DiscordInteractionCallbackResponse }> = [];
  readonly followups: Array<{ applicationId: string; token: string; params: DiscordWebhookMessageParams }> = [];
  readonly dmChannels: string[] = [];
  private nextMessageId = 1;

  async sendMessage(params: DiscordSendMessageParams): Promise<DiscordMessage> {
    this.sent.push(params);
    return { id: String(this.nextMessageId++), channel_id: params.channel_id, content: params.content };
  }

  async createDmChannel(userId: string): Promise<DiscordChannel> {
    this.dmChannels.push(userId);
    return { id: `dm-${userId}` };
  }

  async createInteractionResponse(id: string, token: string, response: DiscordInteractionCallbackResponse): Promise<void> {
    this.callbacks.push({ id, token, response });
  }

  async createFollowupMessage(applicationId: string, token: string, params: DiscordWebhookMessageParams): Promise<DiscordMessage> {
    this.followups.push({ applicationId, token, params });
    return { id: String(this.nextMessageId++), channel_id: "followup", content: params.content };
  }
}

function interaction(options: {
  id: string;
  type: number;
  userId: string;
  channelId: string;
  messageId?: string;
  data?: DiscordInteraction["data"];
}): DiscordInteraction {
  return {
    id: options.id,
    application_id: "123456",
    type: options.type,
    token: `token-${options.id}`,
    channel_id: options.channelId,
    user: { id: options.userId },
    message: options.messageId ? { id: options.messageId, channel_id: options.channelId } : undefined,
    data: options.data
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
