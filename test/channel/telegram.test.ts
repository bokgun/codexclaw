import { describe, expect, test } from "bun:test";
import {
  TelegramChannelAdapter,
  TelegramFetchApiClient,
  type TelegramApiClient,
  type TelegramAnswerCallbackQueryParams,
  type TelegramGetUpdatesParams,
  type TelegramMessage,
  type TelegramSendChatActionParams,
  type TelegramSendMessageParams,
  type TelegramUpdate
} from "../../src/channel/telegram.js";
import type { TelegramConfig } from "../../src/config/env.js";

describe("TelegramChannelAdapter", () => {
  test("normalizes allowed private text messages into channel-neutral messages", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const iterator = adapter.receive[Symbol.asyncIterator]();

    await adapter.processUpdate(textUpdate({ updateId: 1, userId: 42, chatId: 42, messageId: 7, text: "/threads" }));
    const next = await iterator.next();

    expect(next.done).toBe(false);
    expect(next.value).toEqual({
      id: "telegram:42:7",
      userKey: "telegram:42",
      channel: "telegram",
      text: "/threads",
      receivedAt: "2026-05-01T00:00:00.000Z",
      channelThreadKey: "telegram:42",
      replyToMessageId: undefined
    });
    expect(api.sent).toHaveLength(0);
    await adapter.close();
  });

  test("rejects unauthorized users before routing", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const iterator = adapter.receive[Symbol.asyncIterator]();

    await adapter.processUpdate(textUpdate({ updateId: 1, userId: 99, chatId: 99, messageId: 1, text: "hi" }));
    const routed = await Promise.race([iterator.next(), delay(10).then(() => "none" as const)]);

    expect(routed).toBe("none");
    expect(api.sent.map((message) => message.text)).toEqual([
      "This Telegram user is not allowed to use this codexclaw host."
    ]);
    await adapter.close();
  });

  test("rejects group messages and keeps Telegram v1 personal-only", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const iterator = adapter.receive[Symbol.asyncIterator]();

    await adapter.processUpdate(
      textUpdate({ updateId: 1, userId: 42, chatId: -100, messageId: 1, text: "hi", chatType: "supergroup" })
    );
    await adapter.processUpdate(
      textUpdate({ updateId: 2, userId: 42, chatId: -100, messageId: 2, text: "again", chatType: "supergroup" })
    );
    const routed = await Promise.race([iterator.next(), delay(10).then(() => "none" as const)]);

    expect(routed).toBe("none");
    expect(api.sent.map((message) => message.text)).toEqual(["codexclaw Telegram currently supports private chats only."]);
    await adapter.close();
  });

  test("coalesces agent deltas and chunks long outbound messages", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api, { deltaFlushMs: 0 });

    await adapter.send({ kind: "agent_delta", channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42", text: "Hel" });
    await adapter.send({ kind: "agent_delta", channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42", text: "lo" });
    await adapter.send({ kind: "text", channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42", text: "x".repeat(8000) });

    expect(api.sent[0]?.text).toBe("Hel");
    expect(api.sent[1]?.text).toBe("lo");
    expect(api.sent.slice(2)).toHaveLength(3);
    expect(api.sent.slice(2).every((message) => message.text.length <= 3900)).toBe(true);
    await adapter.close();
  });

  test("flushes pending deltas before status messages when coalescing is enabled", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api, { deltaFlushMs: 10_000 });

    await adapter.send({ kind: "agent_delta", channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42", text: "Hello" });
    await adapter.send({ kind: "agent_delta", channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42", text: "." });
    await adapter.send({ kind: "status", channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42", text: "Turn completed." });

    expect(api.sent.map((message) => message.text)).toEqual(["Hello.", "Turn completed."]);
    await adapter.close();
  });

  test("sends inline approval prompts and verifies approve callbacks", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    const prompt = await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "telegram:42",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "telegram:42"
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 1, data: "cc:a:k1:approve" }));
    const approval = await approvals.next();

    expect(prompt).toEqual({ approvalId: "approval-1", channelMessageId: "telegram:42:1" });
    expect(api.sent[0]?.reply_markup).toEqual({
      inline_keyboard: [[
        { text: "Approve", callback_data: "cc:a:k1:approve" },
        { text: "Reject", callback_data: "cc:a:k1:reject" },
        { text: "Modify", callback_data: "cc:a:k1:modify" }
      ]]
    });
    expect(approval.value).toMatchObject({
      approvalId: "approval-1",
      channelMessageId: "telegram:42:1",
      userKey: "telegram:42",
      decision: "approve",
      channelThreadKey: "telegram:42"
    });
    expect(api.answers).toEqual([{ callback_query_id: "callback-2", text: "Approved." }]);
    await adapter.close();
  });

  test("rejects approval callbacks from another user or chat", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "telegram:42",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "telegram:42"
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 43, chatId: 42, messageId: 1, data: "cc:a:k1:approve" }));
    const routed = await Promise.race([approvals.next(), delay(10).then(() => "none" as const)]);

    expect(routed).toBe("none");
    expect(api.answers).toEqual([{
      callback_query_id: "callback-2",
      text: "This Telegram user is not allowed.",
      show_alert: true
    }]);
    await adapter.close();
  });

  test("rejects expired approval callbacks at the Telegram boundary", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "telegram:42",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-04-30T23:59:59.000Z",
      channelThreadKey: "telegram:42"
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 1, data: "cc:a:k1:approve" }));
    const routed = await Promise.race([approvals.next(), delay(10).then(() => "none" as const)]);

    expect(routed).toBe("none");
    expect(api.answers).toEqual([{ callback_query_id: "callback-2", text: "Approval expired." }]);
    await adapter.close();
  });

  test("collects modify replies without routing them as normal messages", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();
    const messages = adapter.receive[Symbol.asyncIterator]();

    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "telegram:42",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "telegram:42"
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 1, data: "cc:a:k1:modify" }));
    const beginModify = await approvals.next();
    await adapter.processUpdate(
      textUpdate({
        updateId: 3,
        userId: 42,
        chatId: 42,
        messageId: 3,
        text: "Use a safer command",
        replyToMessageId: 2
      })
    );
    const completeModify = await approvals.next();
    const routed = await Promise.race([messages.next(), delay(10).then(() => "none" as const)]);

    expect(api.sent.map((message) => message.text)).toEqual([
      "Approval requested\n\nRun command?\n\nExpires at: 2026-05-01T00:05:00.000Z",
      "Reply to this message with the modified instruction.",
      "Modified instruction received."
    ]);
    expect(beginModify.value).toMatchObject({
      approvalId: "approval-1",
      decision: "modify",
      modifyText: undefined
    });
    expect(completeModify.value).toMatchObject({
      approvalId: "approval-1",
      decision: "modify",
      modifyText: "Use a safer command"
    });
    expect(routed).toBe("none");
    await adapter.close();
  });

  test("keeps empty modify replies in the modify prompt instead of emitting approvals", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();
    const messages = adapter.receive[Symbol.asyncIterator]();

    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "telegram:42",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "telegram:42"
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 1, data: "cc:a:k1:modify" }));
    await approvals.next();
    await adapter.processUpdate(
      textUpdate({ updateId: 3, userId: 42, chatId: 42, messageId: 3, text: "   ", replyToMessageId: 2 })
    );
    const approval = await Promise.race([approvals.next(), delay(10).then(() => "none" as const)]);
    const routed = await Promise.race([messages.next(), delay(10).then(() => "none" as const)]);

    expect(approval).toBe("none");
    expect(routed).toBe("none");
    expect(api.sent.at(-1)?.text).toBe("Modified instruction cannot be empty. Reply with the changed instruction.");
    await adapter.close();
  });

  test("ignores late modify replies after adapter timeout without routing them", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api, { modifyTimeoutMs: 1 });
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();
    const messages = adapter.receive[Symbol.asyncIterator]();

    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "telegram:42",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "telegram:42"
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 1, data: "cc:a:k1:modify" }));
    await approvals.next();
    await delay(5);
    await adapter.processUpdate(
      textUpdate({ updateId: 3, userId: 42, chatId: 42, messageId: 3, text: "late modify", replyToMessageId: 2 })
    );
    const approval = await Promise.race([approvals.next(), delay(10).then(() => "none" as const)]);
    const routed = await Promise.race([messages.next(), delay(10).then(() => "none" as const)]);

    expect(approval).toBe("none");
    expect(routed).toBe("none");
    expect(api.sent.at(-1)?.text).toBe("Modify expired. The reply was ignored.");
    await adapter.close();
  });

  test("scopes modify replies by chat when Telegram message ids collide", async () => {
    const api = new FakeTelegramApi({ perChatMessageIds: true });
    const keys = ["k1", "k2"];
    const adapter = new TelegramChannelAdapter({
      config: telegramConfig({ allowedUserIds: ["42", "43"] }),
      apiClient: api,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
      keyFactory: () => keys.shift() ?? "unused",
      startPolling: false
    });
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();
    const messages = adapter.receive[Symbol.asyncIterator]();

    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "telegram:42",
      threadId: "thread-1",
      prompt: "Run command 1?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "telegram:42"
    });
    await adapter.requestApproval({
      approvalId: "approval-2",
      userKey: "telegram:43",
      threadId: "thread-2",
      prompt: "Run command 2?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:05:00.000Z",
      channelThreadKey: "telegram:43"
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 1, data: "cc:a:k1:modify" }));
    await adapter.processUpdate(callbackUpdate({ updateId: 3, userId: 43, chatId: 43, messageId: 1, data: "cc:a:k2:modify" }));
    await approvals.next();
    await approvals.next();

    await adapter.processUpdate(
      textUpdate({
        updateId: 4,
        userId: 42,
        chatId: 42,
        messageId: 3,
        text: "first chat modify",
        replyToMessageId: 2
      })
    );
    const approval = await approvals.next();
    const routed = await Promise.race([messages.next(), delay(10).then(() => "none" as const)]);

    expect(approval.value).toMatchObject({
      approvalId: "approval-1",
      userKey: "telegram:42",
      decision: "modify",
      modifyText: "first chat modify"
    });
    expect(routed).toBe("none");
    await adapter.close();
  });

  test("exposes branch suggestion callback responses for future core wiring", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api, undefined, "branch-key");
    const responses = adapter.branchSuggestionResponses[Symbol.asyncIterator]();

    await adapter.requestBranchSuggestion({
      suggestionId: "suggestion-1",
      userKey: "telegram:42",
      channelThreadKey: "telegram:42",
      text: "Start new thread?",
      expiresAt: "2026-05-01T00:01:00.000Z",
      options: ["new_thread", "continue"]
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 1, data: "cc:b:branch-key:continue" }));
    const response = await responses.next();

    expect(response.value).toEqual({
      suggestionId: "suggestion-1",
      userKey: "telegram:42",
      channelThreadKey: "telegram:42",
      decision: "continue",
      receivedAt: "2026-05-01T00:00:00.000Z"
    });
    await adapter.close();
  });

  test("rejects expired branch suggestion callbacks at the Telegram boundary", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api, undefined, "branch-key");
    const responses = adapter.branchSuggestionResponses[Symbol.asyncIterator]();

    await adapter.requestBranchSuggestion({
      suggestionId: "suggestion-1",
      userKey: "telegram:42",
      channelThreadKey: "telegram:42",
      text: "Start new thread?",
      expiresAt: "2026-04-30T23:59:59.000Z",
      options: ["new_thread", "continue"]
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 1, data: "cc:b:branch-key:continue" }));
    const routed = await Promise.race([responses.next(), delay(10).then(() => "none" as const)]);

    expect(routed).toBe("none");
    expect(api.answers).toEqual([{ callback_query_id: "callback-2", text: "Suggestion expired." }]);
    await adapter.close();
  });

  test("redacts bot tokens from fetch-level Telegram errors", async () => {
    const client = new TelegramFetchApiClient({
      botToken: "123:secret",
      fetch: (() => {
        throw new Error("connect https://api.telegram.org/bot123:secret/getUpdates failed");
      }) as typeof fetch
    });

    await expect(client.getUpdates({ timeout: 1, allowed_updates: [] })).rejects.toThrow("[telegram-bot-token]");
    await expect(client.getUpdates({ timeout: 1, allowed_updates: [] })).rejects.not.toThrow("123:secret");
  });
});

function adapterWith(api: FakeTelegramApi, overrides: Partial<TelegramConfig> = {}, key = "k1"): TelegramChannelAdapter {
  return new TelegramChannelAdapter({
    config: telegramConfig(overrides),
    apiClient: api,
    now: () => new Date("2026-05-01T00:00:00.000Z"),
    keyFactory: () => key,
    startPolling: false
  });
}

function telegramConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    mode: "polling",
    botToken: "123:secret",
    allowedUserIds: ["42"],
    allowAllUsersForLocalDev: false,
    apiBaseUrl: "https://api.telegram.org",
    pollingTimeoutSeconds: 30,
    modifyTimeoutMs: 60_000,
    deltaFlushMs: 750,
    ...overrides
  };
}

class FakeTelegramApi implements TelegramApiClient {
  readonly sent: TelegramSendMessageParams[] = [];
  readonly answers: TelegramAnswerCallbackQueryParams[] = [];
  readonly actions: TelegramSendChatActionParams[] = [];
  private readonly perChatMessageIds: boolean;
  private readonly nextMessageIdByChat = new Map<string, number>();
  private nextMessageId = 1;

  constructor(options: { perChatMessageIds?: boolean } = {}) {
    this.perChatMessageIds = options.perChatMessageIds ?? false;
  }

  async getUpdates(_params: TelegramGetUpdatesParams): Promise<readonly TelegramUpdate[]> {
    return [];
  }

  async sendMessage(params: TelegramSendMessageParams): Promise<TelegramMessage> {
    this.sent.push(params);
    const chatId = Number(params.chat_id);
    return {
      message_id: this.takeMessageId(chatId),
      chat: { id: chatId, type: "private" },
      text: params.text
    };
  }

  async answerCallbackQuery(params: TelegramAnswerCallbackQueryParams): Promise<true> {
    this.answers.push(params);
    return true;
  }

  async sendChatAction(params: TelegramSendChatActionParams): Promise<true> {
    this.actions.push(params);
    return true;
  }

  private takeMessageId(chatId: number): number {
    if (!this.perChatMessageIds) return this.nextMessageId++;
    const key = String(chatId);
    const current = this.nextMessageIdByChat.get(key) ?? 1;
    this.nextMessageIdByChat.set(key, current + 1);
    return current;
  }
}

function textUpdate(options: {
  updateId: number;
  userId: number;
  chatId: number;
  messageId: number;
  text: string;
  chatType?: "private" | "group" | "supergroup" | "channel";
  replyToMessageId?: number;
}): TelegramUpdate {
  return {
    update_id: options.updateId,
    message: {
      message_id: options.messageId,
      chat: { id: options.chatId, type: options.chatType ?? "private" },
      from: { id: options.userId },
      text: options.text,
      reply_to_message:
        options.replyToMessageId === undefined
          ? undefined
          : {
              message_id: options.replyToMessageId,
              chat: { id: options.chatId, type: "private" }
            }
    }
  };
}

function callbackUpdate(options: {
  updateId: number;
  userId: number;
  chatId: number;
  messageId: number;
  data: string;
}): TelegramUpdate {
  return {
    update_id: options.updateId,
    callback_query: {
      id: `callback-${options.updateId}`,
      from: { id: options.userId },
      data: options.data,
      message: {
        message_id: options.messageId,
        chat: { id: options.chatId, type: "private" }
      }
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
