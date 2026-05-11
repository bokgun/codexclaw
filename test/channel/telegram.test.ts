import { describe, expect, test } from "bun:test";
import { mkdtemp, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TelegramChannelAdapter,
  TelegramFetchApiClient,
  type TelegramApiClient,
  type TelegramAnswerCallbackQueryParams,
  type TelegramGetUpdatesParams,
  type TelegramMessage,
  type TelegramSendChatActionParams,
  type TelegramSendDocumentParams,
  type TelegramSendMessageParams,
  type TelegramUpdate
} from "../../src/channel/telegram.js";
import type { TelegramConfig } from "../../src/config/env.js";
import type { LogFields, RuntimeLogger } from "../../src/runtime/log.js";

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

  test("flushes deltas, sends safe text, then sends local documents", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api, { deltaFlushMs: 10_000 });
    const dir = await mkdtemp(join(tmpdir(), "codexclaw-telegram-doc-"));
    const documentPath = join(dir, "report.txt");
    await writeFile(documentPath, "report body");

    await adapter.send({ kind: "agent_delta", channel: "telegram", userKey: "telegram:42", channelThreadKey: "telegram:42", text: "done" });
    await adapter.send({
      kind: "text",
      channel: "telegram",
      userKey: "telegram:42",
      channelThreadKey: "telegram:42",
      text: "Sending report.",
      attachments: [{ kind: "local_document", path: documentPath, displayName: "../report.txt", sizeBytes: 11, contentType: "text/plain" }]
    });

    expect(api.sent.map((message) => message.text)).toEqual(["done", "Sending report."]);
    expect(api.documents).toEqual([
      {
        chat_id: 42,
        document: {
          path: documentPath,
          filename: "report.txt",
          sizeBytes: 11,
          dev: expect.any(Number),
          ino: expect.any(Number),
          mtimeMs: expect.any(Number),
          contentType: "text/plain"
        }
      }
    ]);
    await adapter.close();
  });

  test("falls back without uploading changed, oversized, or symlink documents", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const dir = await mkdtemp(join(tmpdir(), "codexclaw-telegram-doc-"));
    const changedPath = join(dir, "changed.txt");
    const oversizedPath = join(dir, "oversized.bin");
    const targetPath = join(dir, "target.txt");
    const symlinkPath = join(dir, "linked.txt");
    await writeFile(changedPath, "changed");
    await writeFile(oversizedPath, new Uint8Array(49 * 1024 * 1024 + 1));
    await writeFile(targetPath, "target");
    await symlink(targetPath, symlinkPath);

    await adapter.send({
      kind: "text",
      channel: "telegram",
      userKey: "telegram:42",
      channelThreadKey: "telegram:42",
      text: "Sending files.",
      attachments: [
        { kind: "local_document", path: changedPath, displayName: "changed.txt", sizeBytes: 1 },
        { kind: "local_document", path: oversizedPath, displayName: "oversized.bin" },
        { kind: "local_document", path: symlinkPath, displayName: "linked.txt" }
      ]
    });

    expect(api.documents).toHaveLength(0);
    expect(api.sent.map((message) => message.text)).toEqual([
      "Sending files.",
      [
        "Some files could not be sent:",
        "- changed.txt: file changed before upload",
        "- oversized.bin: file is too large for Telegram delivery",
        "- linked.txt: symlink documents are not sent"
      ].join("\n")
    ]);
    await adapter.close();
  });

  test("rejects same-size document swaps after validation metadata is captured", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const dir = await mkdtemp(join(tmpdir(), "codexclaw-telegram-doc-"));
    const documentPath = join(dir, "report.txt");
    const replacementPath = join(dir, "replacement.txt");
    await writeFile(documentPath, "first");
    const original = await stat(documentPath);
    await writeFile(replacementPath, "other");
    await rename(replacementPath, documentPath);

    await adapter.send({
      kind: "text",
      channel: "telegram",
      userKey: "telegram:42",
      channelThreadKey: "telegram:42",
      text: "Sending file.",
      attachments: [
        {
          kind: "local_document",
          path: documentPath,
          displayName: "report.txt",
          sizeBytes: original.size,
          dev: original.dev,
          ino: original.ino,
          mtimeMs: original.mtimeMs
        }
      ]
    });

    expect(api.documents).toHaveLength(0);
    expect(api.sent.at(-1)?.text).toContain("- report.txt: file changed before upload");
    await adapter.close();
  });

  test("falls back when Telegram document upload fails without logging file contents", async () => {
    const api = new FakeTelegramApi({ failDocuments: true });
    const logger = new MemoryLogger();
    const adapter = new TelegramChannelAdapter({
      config: telegramConfig(),
      apiClient: api,
      logger,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
      keyFactory: () => "k1",
      startPolling: false
    });
    const dir = await mkdtemp(join(tmpdir(), "codexclaw-telegram-doc-"));
    const documentPath = join(dir, "secret.txt");
    await writeFile(documentPath, "file contents must not appear in logs");

    await adapter.send({
      kind: "text",
      channel: "telegram",
      userKey: "telegram:42",
      channelThreadKey: "telegram:42",
      text: "Sending file.",
      attachments: [{ kind: "local_document", path: documentPath, displayName: "secret.txt" }]
    });

    expect(api.documents).toHaveLength(1);
    expect(api.sent.at(-1)?.text).toContain("- secret.txt: Telegram upload failed");
    expect(JSON.stringify(logger.warns)).not.toContain("file contents must not appear in logs");
    expect(JSON.stringify(logger.warns)).not.toContain(documentPath);
    expect(JSON.stringify(logger.warns)).not.toContain("123:secret");
    await adapter.close();
  });

  test("maps local upload reason codes to local fallback text", async () => {
    const api = new FakeTelegramApi({ documentError: new Error("local_document_changed") });
    const logger = new MemoryLogger();
    const adapter = new TelegramChannelAdapter({
      config: telegramConfig(),
      apiClient: api,
      logger,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
      keyFactory: () => "k1",
      startPolling: false
    });
    const dir = await mkdtemp(join(tmpdir(), "codexclaw-telegram-doc-"));
    const documentPath = join(dir, "changed.txt");
    await writeFile(documentPath, "changed");

    await adapter.send({
      kind: "text",
      channel: "telegram",
      userKey: "telegram:42",
      channelThreadKey: "telegram:42",
      text: "Sending file.",
      attachments: [{ kind: "local_document", path: documentPath, displayName: "changed.txt" }]
    });

    expect(api.documents).toHaveLength(1);
    expect(api.sent.at(-1)?.text).toContain("- changed.txt: file changed before upload");
    expect(logger.warns).toEqual([
      { event: "telegram_document_send_failed", fields: { userKey: "telegram:42", reason: "local_document_changed" } }
    ]);
    expect(JSON.stringify(logger.warns)).not.toContain(documentPath);
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

  test("rejects approval callbacks exactly at expiry at the Telegram boundary", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    await adapter.requestApproval({
      approvalId: "approval-1",
      userKey: "telegram:42",
      threadId: "thread-1",
      prompt: "Run command?",
      options: ["approve", "reject", "modify"],
      expiresAt: "2026-05-01T00:00:00.000Z",
      channelThreadKey: "telegram:42"
    });
    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 1, data: "cc:a:k1:approve" }));
    const routed = await Promise.race([approvals.next(), delay(10).then(() => "none" as const)]);

    expect(routed).toBe("none");
    expect(api.answers).toEqual([{ callback_query_id: "callback-2", text: "Approval expired." }]);
    await adapter.close();
  });

  test("emits recovery-capable approval responses on approval callback memory miss", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 9, data: "cc:a:old-key:approve" }));
    const approval = await approvals.next();

    expect(approval.value).toMatchObject({
      approvalId: "old-key",
      channelMessageId: "telegram:42:9",
      userKey: "telegram:42",
      decision: "approve",
      channelThreadKey: "telegram:42",
      recovery: {
        channel: "telegram",
        channelMessageId: "telegram:42:9"
      }
    });
    expect(api.answers).toEqual([{ callback_query_id: "callback-2", text: "Approval response received." }]);
    await adapter.close();
  });

  test("maps recovered modify callbacks to a recovery response without collecting prompt text", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 9, data: "cc:a:old-key:modify" }));
    const approval = await approvals.next();

    expect(approval.value).toMatchObject({
      approvalId: "old-key",
      channelMessageId: "telegram:42:9",
      userKey: "telegram:42",
      decision: "modify",
      channelThreadKey: "telegram:42",
      recovery: {
        channel: "telegram",
        channelMessageId: "telegram:42:9"
      }
    });
    expect(approval.value.modifyText).toBeUndefined();
    expect(api.answers).toEqual([
      {
        callback_query_id: "callback-2",
        text: "Modify is unavailable after restart. The approval will be rejected; send a fresh instruction."
      }
    ]);
    await adapter.close();
  });

  test("fails closed before recovery for unauthorized or shared-chat approval callbacks", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 43, chatId: 43, messageId: 9, data: "cc:a:old-key:approve" }));
    await adapter.processUpdate(
      callbackUpdate({ updateId: 3, userId: 42, chatId: -100, messageId: 9, data: "cc:a:old-key:approve", chatType: "supergroup" })
    );
    const routed = await Promise.race([approvals.next(), delay(10).then(() => "none" as const)]);

    expect(routed).toBe("none");
    expect(api.answers).toEqual([
      { callback_query_id: "callback-2", text: "This Telegram user is not allowed.", show_alert: true },
      { callback_query_id: "callback-3", text: "Private chats only.", show_alert: true }
    ]);
    await adapter.close();
  });

  test("fails closed before recovery for malformed or message-less callbacks", async () => {
    const api = new FakeTelegramApi();
    const adapter = adapterWith(api);
    const approvals = adapter.approvalResponses[Symbol.asyncIterator]();

    await adapter.processUpdate(callbackUpdate({ updateId: 2, userId: 42, chatId: 42, messageId: 9, data: "bad:data" }));
    await adapter.processUpdate(callbackUpdateWithoutMessage({ updateId: 3, userId: 42, data: "cc:a:old-key:approve" }));
    const routed = await Promise.race([approvals.next(), delay(10).then(() => "none" as const)]);

    expect(routed).toBe("none");
    expect(api.answers).toEqual([
      { callback_query_id: "callback-2", text: "Unknown or expired action." },
      { callback_query_id: "callback-3", text: "Unknown or expired action." }
    ]);
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

  test("redacts bot tokens from sendDocument fetch errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codexclaw-telegram-doc-"));
    const documentPath = join(dir, "report.txt");
    await writeFile(documentPath, "report");
    const client = new TelegramFetchApiClient({
      botToken: "123:secret",
      fetch: (() => {
        throw new Error("connect https://api.telegram.org/bot123:secret/sendDocument failed");
      }) as typeof fetch
    });

    await expect(client.sendDocument({ chat_id: 42, document: { path: documentPath, filename: "report.txt", sizeBytes: 6 } })).rejects.toThrow(
      "[telegram-bot-token]"
    );
    await expect(client.sendDocument({ chat_id: 42, document: { path: documentPath, filename: "report.txt", sizeBytes: 6 } })).rejects.not.toThrow(
      "123:secret"
    );
  });

  test("TelegramFetchApiClient sends sendDocument as multipart form data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codexclaw-telegram-doc-"));
    const documentPath = join(dir, "report.txt");
    await writeFile(documentPath, "report");
    let requestedUrl = "";
    let requestedBody: BodyInit | null | undefined;
    const client = new TelegramFetchApiClient({
      botToken: "123:secret",
      fetch: ((url, init) => {
        requestedUrl = String(url);
        requestedBody = init?.body;
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 42, type: "private" } } }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }) as typeof fetch
    });

    await client.sendDocument({ chat_id: 42, document: { path: documentPath, filename: "../report.txt", sizeBytes: 6 } });

    expect(requestedUrl).toBe("https://api.telegram.org/bot123:secret/sendDocument");
    expect(requestedBody).toBeInstanceOf(FormData);
    const form = requestedBody as FormData;
    expect(form.get("chat_id")).toBe("42");
    const file = form.get("document") as File;
    expect(file.name).toBe("report.txt");
    expect(await file.text()).toBe("report");
  });

  test("logs and stops on duplicate long-polling Telegram conflicts", async () => {
    const api = new ConflictTelegramApi();
    const logger = new MemoryLogger();
    const adapter = new TelegramChannelAdapter({
      config: telegramConfig(),
      apiClient: api,
      logger,
      now: () => new Date("2026-05-01T00:00:00.000Z"),
      keyFactory: () => "k1",
      startPolling: true
    });
    const messages = adapter.receive[Symbol.asyncIterator]();

    await delay(20);
    const closed = await Promise.race([messages.next(), delay(10).then(() => "open" as const)]);
    await adapter.close();

    expect(api.getUpdatesCalls).toBe(1);
    expect(closed).toEqual({ done: true, value: undefined });
    expect(logger.errors).toEqual([
      {
        event: "telegram_polling_conflict",
        fields: {
          error: "Telegram getUpdates failed: Conflict: terminated by other getUpdates request",
          action: "stopped"
        }
      }
    ]);
    expect(logger.warns).toEqual([]);
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
  readonly documents: TelegramSendDocumentParams[] = [];
  readonly answers: TelegramAnswerCallbackQueryParams[] = [];
  readonly actions: TelegramSendChatActionParams[] = [];
  private readonly perChatMessageIds: boolean;
  private readonly failDocuments: boolean;
  private readonly documentError?: Error;
  private readonly nextMessageIdByChat = new Map<string, number>();
  private nextMessageId = 1;

  constructor(options: { perChatMessageIds?: boolean; failDocuments?: boolean; documentError?: Error } = {}) {
    this.perChatMessageIds = options.perChatMessageIds ?? false;
    this.failDocuments = options.failDocuments ?? false;
    this.documentError = options.documentError;
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

  async sendDocument(params: TelegramSendDocumentParams): Promise<TelegramMessage> {
    this.documents.push(params);
    if (this.documentError) throw this.documentError;
    if (this.failDocuments) throw new Error("Telegram sendDocument failed: token 123:secret");
    const chatId = Number(params.chat_id);
    return {
      message_id: this.takeMessageId(chatId),
      chat: { id: chatId, type: "private" }
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

class ConflictTelegramApi extends FakeTelegramApi {
  getUpdatesCalls = 0;

  override async getUpdates(_params: TelegramGetUpdatesParams): Promise<readonly TelegramUpdate[]> {
    this.getUpdatesCalls += 1;
    throw new Error("Telegram getUpdates failed: Conflict: terminated by other getUpdates request");
  }
}

class MemoryLogger implements RuntimeLogger {
  readonly debugs: Array<{ event: string; fields?: LogFields }> = [];
  readonly infos: Array<{ event: string; fields?: LogFields }> = [];
  readonly warns: Array<{ event: string; fields?: LogFields }> = [];
  readonly errors: Array<{ event: string; fields?: LogFields }> = [];

  debug(event: string, fields?: LogFields): void {
    this.debugs.push({ event, fields });
  }

  info(event: string, fields?: LogFields): void {
    this.infos.push({ event, fields });
  }

  warn(event: string, fields?: LogFields): void {
    this.warns.push({ event, fields });
  }

  error(event: string, fields?: LogFields): void {
    this.errors.push({ event, fields });
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
  chatType?: "private" | "group" | "supergroup" | "channel";
}): TelegramUpdate {
  return {
    update_id: options.updateId,
    callback_query: {
      id: `callback-${options.updateId}`,
      from: { id: options.userId },
      data: options.data,
      message: {
        message_id: options.messageId,
        chat: { id: options.chatId, type: options.chatType ?? "private" }
      }
    }
  };
}

function callbackUpdateWithoutMessage(options: { updateId: number; userId: number; data: string }): TelegramUpdate {
  return {
    update_id: options.updateId,
    callback_query: {
      id: `callback-${options.updateId}`,
      from: { id: options.userId },
      data: options.data
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
