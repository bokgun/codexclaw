import { randomBytes } from "node:crypto";
import { createJsonLineLogger, type RuntimeLogger } from "../runtime/log.js";
import { redactTelegramSecrets, type TelegramConfig } from "../config/env.js";
import type {
  ApprovalDecision,
  ChannelBranchSuggestionRequest,
  ChannelBranchSuggestionResponse,
  ChannelAdapter,
  ChannelApprovalPrompt,
  ChannelApprovalRequest,
  ChannelApprovalResponse,
  ChannelMessageId,
  ChannelSendResult,
  NormalizedMessage,
  OutboundMessage,
  UserKey
} from "./types.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const SAFE_CHUNK_LIMIT = 3900;
const RECENT_UPDATE_LIMIT = 256;

export interface TelegramApiClient {
  getUpdates(params: TelegramGetUpdatesParams, signal?: AbortSignal): Promise<readonly TelegramUpdate[]>;
  sendMessage(params: TelegramSendMessageParams): Promise<TelegramMessage>;
  editMessageText?(params: TelegramEditMessageTextParams): Promise<TelegramMessage | true>;
  answerCallbackQuery(params: TelegramAnswerCallbackQueryParams): Promise<true>;
  sendChatAction?(params: TelegramSendChatActionParams): Promise<true>;
}

export interface TelegramAdapterOptions {
  config: TelegramConfig;
  apiClient?: TelegramApiClient;
  fetch?: typeof fetch;
  logger?: RuntimeLogger;
  now?: () => Date;
  keyFactory?: () => string;
  startPolling?: boolean;
}

export interface TelegramGetUpdatesParams {
  offset?: number;
  timeout: number;
  allowed_updates: readonly string[];
}

export interface TelegramSendMessageParams {
  chat_id: number | string;
  text: string;
  reply_to_message_id?: number;
  disable_web_page_preview?: boolean;
  reply_markup?: TelegramReplyMarkup;
}

export interface TelegramEditMessageTextParams {
  chat_id: number | string;
  message_id: number;
  text: string;
  reply_markup?: TelegramReplyMarkup;
}

export interface TelegramAnswerCallbackQueryParams {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

export interface TelegramSendChatActionParams {
  chat_id: number | string;
  action: "typing";
}

export type TelegramReplyMarkup =
  | { inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[] }
  | { force_reply: true; selective?: boolean; input_field_placeholder?: string };

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel" | string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

export class TelegramFetchApiClient implements TelegramApiClient {
  private readonly apiBaseUrl: string;
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { botToken: string; apiBaseUrl?: string; fetch?: typeof fetch }) {
    this.botToken = options.botToken;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  getUpdates(params: TelegramGetUpdatesParams, signal?: AbortSignal): Promise<readonly TelegramUpdate[]> {
    return this.call<readonly TelegramUpdate[]>("getUpdates", params, signal);
  }

  sendMessage(params: TelegramSendMessageParams): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", params);
  }

  editMessageText(params: TelegramEditMessageTextParams): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>("editMessageText", params);
  }

  answerCallbackQuery(params: TelegramAnswerCallbackQueryParams): Promise<true> {
    return this.call<true>("answerCallbackQuery", params);
  }

  sendChatAction(params: TelegramSendChatActionParams): Promise<true> {
    return this.call<true>("sendChatAction", params);
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${this.botToken}/${method}`;
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      const payload = (await response.json().catch(() => undefined)) as TelegramApiResponse<T> | undefined;
      if (!response.ok || !payload?.ok) {
        const description = payload && "description" in payload ? payload.description : response.statusText;
        throw new Error(`Telegram ${method} failed: ${description}`);
      }
      return payload.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactTelegramSecrets(message, this.botToken));
    }
  }
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface PendingApproval {
  key: string;
  request: ChannelApprovalRequest;
  chatId: number;
  userId: number;
  messageId: number;
  channelMessageId: ChannelMessageId;
}

interface PendingModify {
  approval: PendingApproval;
  promptMessageId: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingBranchSuggestion {
  key: string;
  request: ChannelBranchSuggestionRequest;
  chatId: number;
  userId: number;
  messageId: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface DeltaBuffer {
  chatId: number | string;
  userKey: UserKey;
  channelThreadKey?: string;
  text: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly name = "telegram" as const;
  readonly receive: AsyncIterable<NormalizedMessage>;
  readonly approvalResponses: AsyncIterable<ChannelApprovalResponse>;
  readonly branchSuggestionResponses: AsyncIterable<ChannelBranchSuggestionResponse>;

  private readonly config: TelegramConfig;
  private readonly api: TelegramApiClient;
  private readonly logger: RuntimeLogger;
  private readonly now: () => Date;
  private readonly keyFactory: () => string;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly messages = new AsyncQueue<NormalizedMessage>();
  private readonly approvals = new AsyncQueue<ChannelApprovalResponse>();
  private readonly branchSuggestions = new AsyncQueue<ChannelBranchSuggestionResponse>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingModifyByPromptMessage = new Map<string, PendingModify>();
  private readonly expiredModifyPromptMessages = new Set<string>();
  private readonly pendingBranchSuggestions = new Map<string, PendingBranchSuggestion>();
  private readonly unsupportedChats = new Set<number>();
  private readonly rejectedSharedChats = new Set<number>();
  private readonly recentUpdates: number[] = [];
  private readonly recentUpdateSet = new Set<number>();
  private readonly deltaBuffers = new Map<string, DeltaBuffer>();
  private readonly abort = new AbortController();
  private nextOffset: number | undefined;
  private polling?: Promise<void>;
  private closed = false;

  constructor(options: TelegramAdapterOptions) {
    this.config = options.config;
    this.api =
      options.apiClient ??
      new TelegramFetchApiClient({
        botToken: options.config.botToken,
        apiBaseUrl: options.config.apiBaseUrl,
        fetch: options.fetch
      });
    this.logger = options.logger ?? createJsonLineLogger({ minLevel: "warn" });
    this.now = options.now ?? (() => new Date());
    this.keyFactory = options.keyFactory ?? defaultKeyFactory;
    this.allowedUserIds = new Set(options.config.allowedUserIds);
    this.receive = this.messages;
    this.approvalResponses = this.approvals;
    this.branchSuggestionResponses = this.branchSuggestions;

    if (options.startPolling ?? true) this.polling = this.pollLoop();
  }

  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    const chatId = this.resolveChatId(message);
    if (message.kind === "agent_delta") {
      await this.bufferDelta(chatId, message);
      return {};
    }

    await this.flushDeltasFor(chatId);
    const text = message.text || " ";
    return this.sendChunked(chatId, text, parseTelegramMessageId(message.replyToMessageId));
  }

  async requestApproval(request: ChannelApprovalRequest): Promise<ChannelApprovalPrompt> {
    const chatId = this.resolveChatId(request);
    await this.flushDeltasFor(chatId);

    const key = this.keyFactory();
    const sent = await this.api.sendMessage({
      chat_id: chatId,
      text: formatApprovalPrompt(request),
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: approvalCallbackData(key, "approve") },
            { text: "Reject", callback_data: approvalCallbackData(key, "reject") },
            { text: "Modify", callback_data: approvalCallbackData(key, "modify") }
          ]
        ]
      }
    });
    const channelMessageId = telegramMessageId(sent.chat.id, sent.message_id);
    const userId = parseTelegramUserKey(request.userKey);
    this.pendingApprovals.set(key, {
      key,
      request,
      chatId: sent.chat.id,
      userId,
      messageId: sent.message_id,
      channelMessageId
    });
    this.logger.info("telegram_approval_prompt_sent", {
      approvalId: request.approvalId,
      userKey: request.userKey,
      threadId: request.threadId,
      channelMessageId,
      expiresAt: request.expiresAt
    });
    return { approvalId: request.approvalId, channelMessageId };
  }

  async requestBranchSuggestion(request: ChannelBranchSuggestionRequest): Promise<ChannelSendResult> {
    const chatId = parseTelegramChannelThreadKey(request.channelThreadKey);
    const key = this.keyFactory();
    const userId = parseTelegramUserKey(request.userKey);
    const sent = await this.api.sendMessage({
      chat_id: chatId,
      text: request.text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "New thread", callback_data: branchCallbackData(key, "new") },
            { text: "Continue", callback_data: branchCallbackData(key, "continue") }
          ]
        ]
      }
    });
    const timeout = this.expiryTimer(request.expiresAt, () => {
      this.pendingBranchSuggestions.delete(key);
    });
    this.pendingBranchSuggestions.set(key, {
      key,
      request,
      chatId: sent.chat.id,
      userId,
      messageId: sent.message_id,
      timeout
    });
    return { channelMessageId: telegramMessageId(sent.chat.id, sent.message_id) };
  }

  async acknowledge(request: { channelThreadKey?: string; userKey: UserKey; kind: "received" | "typing" }): Promise<void> {
    if (request.kind !== "typing" || !this.api.sendChatAction) return;
    const chatId = request.channelThreadKey
      ? parseTelegramChannelThreadKey(request.channelThreadKey)
      : parseTelegramUserKey(request.userKey);
    await this.api.sendChatAction({ chat_id: chatId, action: "typing" });
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    if (this.recentUpdateSet.has(update.update_id)) return;
    if (update.message) await this.processMessage(update.message);
    else if (update.callback_query) await this.processCallback(update.callback_query);
    this.rememberUpdate(update.update_id);
  }

  async flushDeltas(): Promise<void> {
    for (const key of [...this.deltaBuffers.keys()]) await this.flushDeltaKey(key);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const state of this.pendingModifyByPromptMessage.values()) clearTimeout(state.timeout);
    for (const pending of this.pendingBranchSuggestions.values()) clearTimeout(pending.timeout);
    for (const buffer of this.deltaBuffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    await this.flushDeltas().catch((error) => {
      this.logger.warn("telegram_delta_flush_failed_on_close", { error: error instanceof Error ? error.message : String(error) });
    });
    await this.polling?.catch(() => undefined);
    this.messages.close();
    this.approvals.close();
    this.branchSuggestions.close();
  }

  private async pollLoop(): Promise<void> {
    while (!this.closed) {
      try {
        const updates = await this.api.getUpdates(
          {
            offset: this.nextOffset,
            timeout: this.config.pollingTimeoutSeconds,
            allowed_updates: ["message", "callback_query"]
          },
          this.abort.signal
        );
        for (const update of updates) {
          if (this.closed) return;
          await this.processUpdate(update);
          this.nextOffset = update.update_id + 1;
        }
      } catch (error) {
        if (this.closed || this.abort.signal.aborted) return;
        if (isTelegramPollingConflict(error)) {
          this.logger.error("telegram_polling_conflict", {
            error: redactTelegramSecrets(error instanceof Error ? error.message : String(error), this.config.botToken),
            action: "stopped"
          });
          this.stopAfterPollingConflict();
          return;
        }
        this.logger.warn("telegram_poll_failed", {
          error: redactTelegramSecrets(error instanceof Error ? error.message : String(error), this.config.botToken)
        });
        await delay(1_000);
      }
    }
  }

  private async processMessage(message: TelegramMessage): Promise<void> {
    if (!message.from || message.from.is_bot) return;
    if (!this.isAllowedUser(message.from.id)) {
      await this.api.sendMessage({ chat_id: message.chat.id, text: "This Telegram user is not allowed to use this codexclaw host." });
      return;
    }
    if (message.chat.type !== "private") {
      if (!this.rejectedSharedChats.has(message.chat.id)) {
        this.rejectedSharedChats.add(message.chat.id);
        await this.api.sendMessage({ chat_id: message.chat.id, text: "codexclaw Telegram currently supports private chats only." });
      }
      return;
    }
    if (message.text === undefined) {
      if (!this.unsupportedChats.has(message.chat.id)) {
        this.unsupportedChats.add(message.chat.id);
        await this.api.sendMessage({ chat_id: message.chat.id, text: "Only text messages are supported." });
      }
      return;
    }

    if (await this.collectModifyReply(message)) return;

    this.messages.push({
      id: telegramMessageId(message.chat.id, message.message_id),
      userKey: telegramUserKey(message.from.id),
      channel: this.name,
      text: message.text,
      receivedAt: this.now().toISOString(),
      channelThreadKey: telegramChannelThreadKey(message.chat.id),
      replyToMessageId: message.reply_to_message
        ? telegramMessageId(message.chat.id, message.reply_to_message.message_id)
        : undefined
    });
  }

  private async processCallback(callback: TelegramCallbackQuery): Promise<void> {
    const data = parseCallbackData(callback.data);
    if (!callback.message || !data) {
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "Unknown or expired action." });
      return;
    }
    if (!this.isAllowedUser(callback.from.id)) {
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "This Telegram user is not allowed.", show_alert: true });
      return;
    }
    if (callback.message.chat.type !== "private") {
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "Private chats only.", show_alert: true });
      return;
    }

    if (data.kind === "approval") {
      await this.processApprovalCallback(callback, data.key, data.action);
      return;
    }
    await this.processBranchCallback(callback, data.key, data.action);
  }

  private async processApprovalCallback(
    callback: TelegramCallbackQuery,
    key: string,
    action: ApprovalDecision
  ): Promise<void> {
    const pending = this.pendingApprovals.get(key);
    if (!pending || !callback.message) {
      await this.processRecoveredApprovalCallback(callback, key, action);
      return;
    }
    if (!this.callbackMatchesPending(callback, pending)) {
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "Approval belongs to another chat or user.", show_alert: true });
      return;
    }
    if (this.isExpired(pending.request.expiresAt)) {
      this.pendingApprovals.delete(key);
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "Approval expired." });
      return;
    }

    if (action === "modify") {
      const prompt = await this.api.sendMessage({
        chat_id: pending.chatId,
        text: "Reply to this message with the modified instruction.",
        reply_to_message_id: pending.messageId,
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: "Modified instruction"
        }
      });
      this.pendingApprovals.delete(key);
      this.approvals.push(this.buildApprovalResponse(pending, "modify"));
      const promptKey = modifyPromptKey(pending.chatId, prompt.message_id);
      const timeout = setTimeout(() => {
        this.pendingModifyByPromptMessage.delete(promptKey);
        this.expiredModifyPromptMessages.add(promptKey);
      }, this.config.modifyTimeoutMs);
      if (typeof timeout === "object" && timeout && "unref" in timeout) timeout.unref();
      this.pendingModifyByPromptMessage.set(promptKey, {
        approval: pending,
        promptMessageId: prompt.message_id,
        timeout
      });
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "Reply with modified instructions." });
      return;
    }

    this.pendingApprovals.delete(key);
    this.approvals.push(this.buildApprovalResponse(pending, action));
    await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: action === "approve" ? "Approved." : "Rejected." });
  }

  private async processRecoveredApprovalCallback(
    callback: TelegramCallbackQuery,
    key: string,
    action: ApprovalDecision
  ): Promise<void> {
    if (!callback.message) {
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "Approval expired or unknown." });
      return;
    }

    const channelMessageId = telegramMessageId(callback.message.chat.id, callback.message.message_id);
    const userKey = telegramUserKey(callback.from.id);
    const channelThreadKey = telegramChannelThreadKey(callback.message.chat.id);
    this.approvals.push({
      approvalId: key,
      channelMessageId,
      userKey,
      decision: action,
      receivedAt: this.now().toISOString(),
      channelThreadKey,
      recovery: {
        channel: this.name,
        channelMessageId
      }
    });

    this.logger.info("telegram_approval_callback_recovery_attempt", {
      userKey,
      channelMessageId,
      decision: action
    });
    await this.api.answerCallbackQuery({
      callback_query_id: callback.id,
      text:
        action === "modify"
          ? "Modify is unavailable after restart. The approval will be rejected; send a fresh instruction."
          : "Approval response received."
    });
  }

  private async processBranchCallback(
    callback: TelegramCallbackQuery,
    key: string,
    action: "new" | "continue"
  ): Promise<void> {
    const pending = this.pendingBranchSuggestions.get(key);
    if (!pending || !callback.message) {
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "Suggestion expired or unknown." });
      return;
    }
    if (
      pending.userId !== callback.from.id ||
      pending.chatId !== callback.message.chat.id ||
      pending.messageId !== callback.message.message_id
    ) {
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "Suggestion belongs to another chat or user.", show_alert: true });
      return;
    }
    if (this.isExpired(pending.request.expiresAt)) {
      this.clearBranchSuggestion(key, pending);
      await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: "Suggestion expired." });
      return;
    }
    this.clearBranchSuggestion(key, pending);
    this.branchSuggestions.push({
      suggestionId: pending.request.suggestionId,
      userKey: pending.request.userKey,
      channelThreadKey: pending.request.channelThreadKey,
      decision: action === "new" ? "new_thread" : "continue",
      receivedAt: this.now().toISOString()
    });
    await this.api.answerCallbackQuery({ callback_query_id: callback.id, text: action === "new" ? "Starting a new thread." : "Continuing here." });
  }

  private async collectModifyReply(message: TelegramMessage): Promise<boolean> {
    const replyTo = message.reply_to_message?.message_id;
    if (replyTo === undefined || !message.from || message.text === undefined) return false;
    const promptKey = modifyPromptKey(message.chat.id, replyTo);
    const state = this.pendingModifyByPromptMessage.get(promptKey);
    if (!state) {
      if (!this.expiredModifyPromptMessages.has(promptKey)) return false;
      this.expiredModifyPromptMessages.delete(promptKey);
      await this.api.sendMessage({ chat_id: message.chat.id, text: "Modify expired. The reply was ignored." });
      return true;
    }
    const { approval } = state;
    if (approval.userId !== message.from.id || approval.chatId !== message.chat.id) return false;
    const modifyText = message.text.trim();
    if (!modifyText) {
      await this.api.sendMessage({ chat_id: approval.chatId, text: "Modified instruction cannot be empty. Reply with the changed instruction." });
      return true;
    }

    clearTimeout(state.timeout);
    this.pendingModifyByPromptMessage.delete(promptKey);
    this.pendingApprovals.delete(approval.key);
    this.expiredModifyPromptMessages.delete(promptKey);
    this.approvals.push(this.buildApprovalResponse(approval, "modify", modifyText));
    await this.api.sendMessage({ chat_id: approval.chatId, text: "Modified instruction received." });
    return true;
  }

  private buildApprovalResponse(
    pending: PendingApproval,
    decision: ApprovalDecision,
    modifyText?: string
  ): ChannelApprovalResponse {
    return {
      approvalId: pending.request.approvalId,
      channelMessageId: pending.channelMessageId,
      userKey: pending.request.userKey,
      decision,
      modifyText: decision === "modify" ? modifyText : undefined,
      receivedAt: this.now().toISOString(),
      channelThreadKey: pending.request.channelThreadKey
    };
  }

  private callbackMatchesPending(callback: TelegramCallbackQuery, pending: PendingApproval): boolean {
    return (
      callback.from.id === pending.userId &&
      callback.message?.chat.id === pending.chatId &&
      callback.message.message_id === pending.messageId
    );
  }

  private isExpired(expiresAt: string): boolean {
    return this.now().toISOString() >= expiresAt;
  }

  private clearBranchSuggestion(key: string, pending: PendingBranchSuggestion): void {
    clearTimeout(pending.timeout);
    this.pendingBranchSuggestions.delete(key);
  }

  private expiryTimer(expiresAt: string, callback: () => void): ReturnType<typeof setTimeout> {
    const delayMs = Math.max(0, new Date(expiresAt).getTime() - this.now().getTime());
    const timer = setTimeout(callback, delayMs);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
    return timer;
  }

  private async bufferDelta(chatId: number | string, message: OutboundMessage): Promise<void> {
    const key = String(chatId);
    const existing = this.deltaBuffers.get(key);
    if (existing) existing.text += message.text;
    else {
      this.deltaBuffers.set(key, {
        chatId,
        userKey: message.userKey,
        channelThreadKey: message.channelThreadKey,
        text: message.text
      });
    }

    const buffer = this.deltaBuffers.get(key);
    if (!buffer) return;
    if (this.config.deltaFlushMs === 0) {
      await this.flushDeltaKey(key);
      return;
    }
    if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        void this.flushDeltaKey(key);
      }, this.config.deltaFlushMs);
    }
  }

  private async flushDeltasFor(chatId: number | string): Promise<void> {
    await this.flushDeltaKey(String(chatId));
  }

  private async flushDeltaKey(key: string): Promise<void> {
    const buffer = this.deltaBuffers.get(key);
    if (!buffer) return;
    this.deltaBuffers.delete(key);
    if (buffer.timer) clearTimeout(buffer.timer);
    if (!buffer.text) return;
    await this.sendChunked(buffer.chatId, buffer.text);
  }

  private async sendChunked(chatId: number | string, text: string, replyTo?: number): Promise<ChannelSendResult> {
    let first: ChannelMessageId | undefined;
    for (const chunk of chunkText(text, SAFE_CHUNK_LIMIT)) {
      const sent = await this.api.sendMessage({
        chat_id: chatId,
        text: chunk,
        reply_to_message_id: replyTo,
        disable_web_page_preview: true
      });
      first ??= telegramMessageId(sent.chat.id, sent.message_id);
      replyTo = undefined;
    }
    return { channelMessageId: first };
  }

  private resolveChatId(message: Pick<OutboundMessage, "channelThreadKey" | "userKey">): number {
    if (message.channelThreadKey) return parseTelegramChannelThreadKey(message.channelThreadKey);
    return parseTelegramUserKey(message.userKey);
  }

  private isAllowedUser(userId: number): boolean {
    return this.config.allowAllUsersForLocalDev || this.allowedUserIds.has(String(userId));
  }

  private rememberUpdate(updateId: number): void {
    this.recentUpdateSet.add(updateId);
    this.recentUpdates.push(updateId);
    while (this.recentUpdates.length > RECENT_UPDATE_LIMIT) {
      const removed = this.recentUpdates.shift();
      if (removed !== undefined) this.recentUpdateSet.delete(removed);
    }
  }

  private stopAfterPollingConflict(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const state of this.pendingModifyByPromptMessage.values()) clearTimeout(state.timeout);
    for (const pending of this.pendingBranchSuggestions.values()) clearTimeout(pending.timeout);
    for (const buffer of this.deltaBuffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    this.messages.close();
    this.approvals.close();
    this.branchSuggestions.close();
  }
}

export function createTelegramChannelAdapter(options: TelegramAdapterOptions): TelegramChannelAdapter {
  return new TelegramChannelAdapter(options);
}

function formatApprovalPrompt(request: ChannelApprovalRequest): string {
  return [`Approval requested`, "", request.prompt, "", `Expires at: ${request.expiresAt}`].join("\n");
}

function approvalCallbackData(key: string, action: ApprovalDecision): string {
  return `cc:a:${key}:${action}`;
}

function branchCallbackData(key: string, action: "new" | "continue"): string {
  return `cc:b:${key}:${action}`;
}

function parseCallbackData(data: string | undefined):
  | { kind: "approval"; key: string; action: ApprovalDecision }
  | { kind: "branch"; key: string; action: "new" | "continue" }
  | undefined {
  const parts = data?.split(":");
  if (!parts || parts.length !== 4 || parts[0] !== "cc") return undefined;
  if (parts[1] === "a" && isApprovalDecision(parts[3])) return { kind: "approval", key: parts[2], action: parts[3] };
  if (parts[1] === "b" && (parts[3] === "new" || parts[3] === "continue")) {
    return { kind: "branch", key: parts[2], action: parts[3] };
  }
  return undefined;
}

function isApprovalDecision(value: string): value is ApprovalDecision {
  return value === "approve" || value === "reject" || value === "modify";
}

function telegramUserKey(userId: number): UserKey {
  return `telegram:${userId}`;
}

function telegramChannelThreadKey(chatId: number): string {
  return `telegram:${chatId}`;
}

function telegramMessageId(chatId: number, messageId: number): ChannelMessageId {
  return `telegram:${chatId}:${messageId}`;
}

function parseTelegramUserKey(userKey: UserKey): number {
  const match = /^telegram:(-?\d+)$/.exec(userKey);
  if (!match) throw new Error(`Invalid Telegram user key: ${userKey}`);
  return Number.parseInt(match[1], 10);
}

function parseTelegramChannelThreadKey(channelThreadKey: string): number {
  const match = /^telegram:(-?\d+)$/.exec(channelThreadKey);
  if (!match) throw new Error(`Invalid Telegram channel thread key: ${channelThreadKey}`);
  return Number.parseInt(match[1], 10);
}

function parseTelegramMessageId(channelMessageId: ChannelMessageId | undefined): number | undefined {
  const match = channelMessageId ? /^telegram:-?\d+:(\d+)$/.exec(channelMessageId) : undefined;
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function modifyPromptKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function chunkText(text: string, limit: number): readonly string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT && text.length <= limit) return [text || " "];

  const chunks: string[] = [];
  let remaining = text || " ";
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf("\n", limit);
    if (end < Math.floor(limit / 2)) end = remaining.lastIndexOf(" ", limit);
    if (end < Math.floor(limit / 2)) end = limit;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function defaultKeyFactory(): string {
  return randomBytes(8).toString("hex");
}

function isTelegramPollingConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b409\b.*conflict|conflict: terminated by other getUpdates request|terminated by other getUpdates request/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });

        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      }
    };
  }
}
