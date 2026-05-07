import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { createJsonLineLogger, type RuntimeLogger } from "../runtime/log.js";
import { redactDiscordSecrets, type DiscordConfig } from "../config/env.js";
import type {
  ApprovalDecision,
  BranchSuggestionDecision,
  ChannelAdapter,
  ChannelApprovalPrompt,
  ChannelApprovalRequest,
  ChannelApprovalResponse,
  ChannelBranchSuggestionRequest,
  ChannelBranchSuggestionResponse,
  ChannelMessageId,
  ChannelSendResult,
  NormalizedMessage,
  OutboundMessage,
  UserKey
} from "./types.js";

const DISCORD_MESSAGE_LIMIT = 2000;
const SAFE_CHUNK_LIMIT = 1900;
const MAX_INTERACTION_BODY_BYTES = 64 * 1024;
const INTERACTION_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface DiscordApiClient {
  sendMessage(params: DiscordSendMessageParams): Promise<DiscordMessage>;
  createDmChannel(userId: string): Promise<DiscordChannel>;
  createInteractionResponse(
    interactionId: string,
    interactionToken: string,
    response: DiscordInteractionCallbackResponse
  ): Promise<void>;
  createFollowupMessage(applicationId: string, interactionToken: string, params: DiscordWebhookMessageParams): Promise<DiscordMessage>;
}

export interface DiscordAdapterOptions {
  config: DiscordConfig;
  apiClient?: DiscordApiClient;
  fetch?: typeof fetch;
  logger?: RuntimeLogger;
  now?: () => Date;
  keyFactory?: () => string;
  startInteractionServer?: boolean;
  startGateway?: boolean;
}

export interface DiscordSendMessageParams {
  channel_id: string;
  content: string;
  message_reference?: { message_id: string; channel_id?: string };
  components?: readonly DiscordActionRow[];
}

export interface DiscordWebhookMessageParams {
  content?: string;
  flags?: number;
  components?: readonly DiscordActionRow[];
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content?: string;
}

export interface DiscordChannel {
  id: string;
}

export interface DiscordUser {
  id: string;
  bot?: boolean;
  username?: string;
}

export interface DiscordGatewayMessage {
  id: string;
  channel_id: string;
  content?: string;
  author?: DiscordUser;
  guild_id?: string;
  mentions?: readonly DiscordUser[];
  timestamp?: string;
  message_reference?: { message_id?: string };
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  channel_id?: string;
  guild_id?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  message?: DiscordMessage;
  data?: DiscordInteractionData;
}

export interface DiscordInteractionData {
  name?: string;
  custom_id?: string;
  component_type?: number;
  options?: readonly DiscordCommandOption[];
  components?: readonly DiscordActionRow[];
}

export interface DiscordCommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: readonly DiscordCommandOption[];
}

export interface DiscordActionRow {
  type: 1;
  components: readonly DiscordComponent[];
}

export type DiscordComponent =
  | {
      type: 2;
      style: 1 | 2 | 3 | 4;
      label: string;
      custom_id: string;
    }
  | {
      type: 4;
      custom_id: string;
      label: string;
      style: 1 | 2;
      min_length?: number;
      max_length?: number;
      required?: boolean;
      placeholder?: string;
    };

export interface DiscordInteractionCallbackResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    custom_id?: string;
    title?: string;
    components?: readonly DiscordActionRow[];
  };
}

interface PendingApproval {
  key: string;
  request: ChannelApprovalRequest;
  userId: string;
  channelId: string;
  messageId: string;
  channelMessageId: ChannelMessageId;
}

interface PendingBranchSuggestion {
  key: string;
  request: ChannelBranchSuggestionRequest;
  userId: string;
  channelId: string;
  messageId: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface DeltaBuffer {
  channelId: string;
  userKey: UserKey;
  channelThreadKey?: string;
  text: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class DiscordFetchApiClient implements DiscordApiClient {
  private readonly apiBaseUrl: string;
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { botToken: string; apiBaseUrl?: string; fetch?: typeof fetch }) {
    this.botToken = options.botToken;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://discord.com/api/v10").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  sendMessage(params: DiscordSendMessageParams): Promise<DiscordMessage> {
    return this.call<DiscordMessage>(`/channels/${params.channel_id}/messages`, params);
  }

  async createInteractionResponse(
    interactionId: string,
    interactionToken: string,
    response: DiscordInteractionCallbackResponse
  ): Promise<void> {
    await this.call<void>(`/interactions/${interactionId}/${interactionToken}/callback`, response);
  }

  createFollowupMessage(applicationId: string, interactionToken: string, params: DiscordWebhookMessageParams): Promise<DiscordMessage> {
    return this.call<DiscordMessage>(`/webhooks/${applicationId}/${interactionToken}`, params);
  }

  createDmChannel(userId: string): Promise<DiscordChannel> {
    return this.call<DiscordChannel>("/users/@me/channels", { recipient_id: userId });
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bot ${this.botToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) {
        const description =
          payload && typeof payload === "object" && "message" in payload ? String(payload.message) : response.statusText;
        throw new Error(`Discord API request failed: ${description}`);
      }
      return payload as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(redactDiscordSecrets(message, this.botToken));
    }
  }
}

export class DiscordChannelAdapter implements ChannelAdapter {
  readonly name = "discord" as const;
  readonly receive: AsyncIterable<NormalizedMessage>;
  readonly approvalResponses: AsyncIterable<ChannelApprovalResponse>;
  readonly branchSuggestionResponses: AsyncIterable<ChannelBranchSuggestionResponse>;

  private readonly config: DiscordConfig;
  private readonly api: DiscordApiClient;
  private readonly logger: RuntimeLogger;
  private readonly now: () => Date;
  private readonly keyFactory: () => string;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly allowedGuildIds: ReadonlySet<string>;
  private readonly messages = new AsyncQueue<NormalizedMessage>();
  private readonly approvals = new AsyncQueue<ChannelApprovalResponse>();
  private readonly branchSuggestions = new AsyncQueue<ChannelBranchSuggestionResponse>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingBranchSuggestions = new Map<string, PendingBranchSuggestion>();
  private readonly deltaBuffers = new Map<string, DeltaBuffer>();
  private readonly processedInteractions = new Map<string, number>();
  private gateway?: WebSocket;
  private gatewayHeartbeat?: ReturnType<typeof setInterval>;
  private server?: { stop(force?: boolean): void };
  private closed = false;

  constructor(options: DiscordAdapterOptions) {
    this.config = options.config;
    this.api =
      options.apiClient ??
      new DiscordFetchApiClient({
        botToken: options.config.botToken,
        apiBaseUrl: options.config.apiBaseUrl,
        fetch: options.fetch
      });
    this.logger = options.logger ?? createJsonLineLogger({ minLevel: "warn" });
    this.now = options.now ?? (() => new Date());
    this.keyFactory = options.keyFactory ?? defaultKeyFactory;
    this.allowedUserIds = new Set(options.config.allowedUserIds);
    this.allowedGuildIds = new Set(options.config.allowedGuildIds);
    this.receive = this.messages;
    this.approvalResponses = this.approvals;
    this.branchSuggestionResponses = this.branchSuggestions;

    if (options.startInteractionServer ?? false) this.startInteractionServer();
    if (options.startGateway ?? false) this.startGateway();
  }

  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    const channelId = await this.resolveChannelId(message);
    if (message.kind === "agent_delta") {
      await this.bufferDelta(channelId, message);
      return {};
    }

    await this.flushDeltasFor(channelId);
    return this.sendChunked(channelId, message.text || " ", parseDiscordMessageId(message.replyToMessageId));
  }

  async requestApproval(request: ChannelApprovalRequest): Promise<ChannelApprovalPrompt> {
    const channelId = await this.resolveChannelId(request);
    await this.flushDeltasFor(channelId);

    const key = this.keyFactory();
    const sent = await this.api.sendMessage({
      channel_id: channelId,
      content: formatApprovalPrompt(request),
      components: [buttonRow([
        { type: 2, label: "Approve", custom_id: approvalCustomId(key, "approve"), style: 3 },
        { type: 2, label: "Reject", custom_id: approvalCustomId(key, "reject"), style: 4 },
        { type: 2, label: "Modify", custom_id: approvalCustomId(key, "modify"), style: 2 }
      ])]
    });
    const channelMessageId = discordMessageId(sent.channel_id, sent.id);
    this.pendingApprovals.set(key, {
      key,
      request,
      userId: parseDiscordUserKey(request.userKey),
      channelId: sent.channel_id,
      messageId: sent.id,
      channelMessageId
    });
    this.logger.info("discord_approval_prompt_sent", {
      approvalId: request.approvalId,
      userKey: request.userKey,
      threadId: request.threadId,
      channelMessageId,
      expiresAt: request.expiresAt
    });
    return { approvalId: request.approvalId, channelMessageId };
  }

  async requestBranchSuggestion(request: ChannelBranchSuggestionRequest): Promise<ChannelSendResult> {
    const channelId = parseDiscordChannelThreadKey(request.channelThreadKey);
    const key = this.keyFactory();
    const sent = await this.api.sendMessage({
      channel_id: channelId,
      content: formatBranchSuggestionPrompt(request.text),
      components: [buttonRow([
        { type: 2, label: "New thread", custom_id: branchCustomId(key, "new"), style: 1 },
        { type: 2, label: "Continue", custom_id: branchCustomId(key, "continue"), style: 2 }
      ])]
    });
    const timeout = this.expiryTimer(request.expiresAt, () => {
      this.pendingBranchSuggestions.delete(key);
    });
    this.pendingBranchSuggestions.set(key, {
      key,
      request,
      userId: parseDiscordUserKey(request.userKey),
      channelId: sent.channel_id,
      messageId: sent.id,
      timeout
    });
    return { channelMessageId: discordMessageId(sent.channel_id, sent.id) };
  }

  async acknowledge(request: { channelThreadKey?: string; userKey: UserKey; kind: "received" | "typing" }): Promise<void> {
    if (request.kind !== "received") return;
  }

  async processGatewayMessage(message: DiscordGatewayMessage): Promise<void> {
    const author = message.author;
    if (!author || author.bot || !message.content) return;
    if (!this.isAllowedGuild(message.guild_id)) return;
    if (!this.isAllowedUser(author.id)) {
      await this.api.sendMessage({
        channel_id: message.channel_id,
        content: "This Discord user is not allowed to use this codexclaw host."
      });
      return;
    }

    const normalizedText = this.normalizeGatewayText(message);
    if (normalizedText === undefined) return;
    if (normalizedText.startsWith("/")) {
      await this.api.sendMessage({
        channel_id: message.channel_id,
        content:
          "That was received as normal Discord message text, not a signed app command. Use a registered Discord slash command, or send a normal prompt without a leading slash."
      });
      return;
    }
    if (await this.tryProcessTextApproval(message, author, normalizedText)) return;
    if (this.tryProcessTextBranchSuggestion(message, author, normalizedText)) return;
    const routedText = normalizeDiscordTextCommandAlias(normalizedText);

    this.messages.push({
      id: discordMessageId(message.channel_id, message.id),
      userKey: discordUserKey(author.id),
      channel: this.name,
      text: routedText,
      receivedAt: message.timestamp ?? this.now().toISOString(),
      channelThreadKey: discordChannelThreadKey(message.channel_id),
      replyToMessageId: message.message_reference?.message_id
        ? discordMessageId(message.channel_id, message.message_reference.message_id)
        : undefined
    });
  }

  async processInteraction(interaction: DiscordInteraction): Promise<void> {
    if (interaction.application_id !== this.config.applicationId) {
      await this.safeInteractionReply(interaction, "Unknown Discord application.", true);
      return;
    }
    if (interaction.type === 1) {
      await this.api.createInteractionResponse(interaction.id, interaction.token, { type: 1 });
      return;
    }

    const user = interaction.user ?? interaction.member?.user;
    if (!user || user.bot) {
      await this.safeInteractionReply(interaction, "Unknown Discord user.", true);
      return;
    }
    if (!this.isAllowedUser(user.id)) {
      await this.safeInteractionReply(interaction, "This Discord user is not allowed.", true);
      return;
    }
    if (!this.isAllowedGuild(interaction.guild_id)) {
      await this.safeInteractionReply(interaction, "This Discord guild is not allowed.", true);
      return;
    }

    if (interaction.type === 2) {
      await this.processCommandInteraction(interaction, user);
      return;
    }
    if (interaction.type === 3) {
      await this.processComponentInteraction(interaction, user);
      return;
    }
    if (interaction.type === 5) {
      await this.processModalSubmitInteraction(interaction, user);
      return;
    }

    await this.safeInteractionReply(interaction, "Unsupported Discord interaction.", true);
  }

  async handleInteractionRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== this.config.interactionsPath) return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const timestamp = request.headers.get("x-signature-timestamp");
    const signature = request.headers.get("x-signature-ed25519");
    const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_INTERACTION_BODY_BYTES) {
      return new Response("request body too large", { status: 413 });
    }
    let body: Uint8Array;
    try {
      body = await readLimitedRequestBody(request, MAX_INTERACTION_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return new Response("request body too large", { status: 413 });
      throw error;
    }
    if (body.byteLength > MAX_INTERACTION_BODY_BYTES) return new Response("request body too large", { status: 413 });
    if (
      !timestamp ||
      !signature ||
      !verifyDiscordInteractionSignature({
        publicKeyHex: this.config.publicKey,
        timestamp,
        body,
        signatureHex: signature,
        now: this.now(),
        replayWindowMs: INTERACTION_REPLAY_WINDOW_MS
      })
    ) {
      return new Response("bad request signature", { status: 401 });
    }

    const interaction = JSON.parse(Buffer.from(body).toString("utf8")) as DiscordInteraction;
    if (this.hasProcessedInteraction(interaction.id)) return new Response("duplicate interaction", { status: 409 });
    this.rememberInteraction(interaction.id);
    if (interaction.type === 1) {
      return Response.json({ type: 1 });
    }

    try {
      await this.processInteraction(interaction);
    } catch (error) {
      this.logger.warn("discord_interaction_failed", {
        error: redactDiscordSecrets(error instanceof Error ? error.message : String(error), this.config.botToken)
      });
      return new Response("interaction failed", { status: 500 });
    }
    return new Response(null, { status: 204 });
  }

  async flushDeltas(): Promise<void> {
    for (const key of [...this.deltaBuffers.keys()]) await this.flushDeltaKey(key);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.server?.stop(true);
    if (this.gatewayHeartbeat) clearInterval(this.gatewayHeartbeat);
    this.gateway?.close();
    for (const pending of this.pendingBranchSuggestions.values()) clearTimeout(pending.timeout);
    for (const buffer of this.deltaBuffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    await this.flushDeltas().catch((error) => {
      this.logger.warn("discord_delta_flush_failed_on_close", { error: error instanceof Error ? error.message : String(error) });
    });
    this.messages.close();
    this.approvals.close();
    this.branchSuggestions.close();
  }

  private startInteractionServer(): void {
    const bun = globalThis as typeof globalThis & {
      Bun?: {
        serve(options: {
          hostname: string;
          port: number;
          fetch(request: Request): Response | Promise<Response>;
        }): { stop(force?: boolean): void };
      };
    };
    if (!bun.Bun) throw new Error("Discord interaction server requires Bun.serve");
    this.server = bun.Bun.serve({
      hostname: this.config.interactionsHost,
      port: this.config.interactionsPort,
      fetch: (request: Request) => this.handleInteractionRequest(request)
    });
    this.logger.info("discord_interactions_listening", {
      host: this.config.interactionsHost,
      port: this.config.interactionsPort,
      path: this.config.interactionsPath
    });
  }

  private startGateway(): void {
    const url = this.config.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
    this.gateway = new WebSocket(url);
    this.gateway.addEventListener("message", (event) => {
      void this.handleGatewayPayload(String(event.data)).catch((error) => {
        this.logger.warn("discord_gateway_message_failed", {
          error: redactDiscordSecrets(error instanceof Error ? error.message : String(error), this.config.botToken)
        });
      });
    });
    this.gateway.addEventListener("close", () => {
      if (this.gatewayHeartbeat) clearInterval(this.gatewayHeartbeat);
      this.gatewayHeartbeat = undefined;
      this.gateway = undefined;
    });
  }

  private async handleGatewayPayload(raw: string): Promise<void> {
    const payload = JSON.parse(raw) as { op?: number; t?: string; s?: number; d?: unknown };
    if (payload.op === 10 && payload.d && typeof payload.d === "object" && "heartbeat_interval" in payload.d) {
      const intervalMs = Number((payload.d as { heartbeat_interval: unknown }).heartbeat_interval);
      this.gatewayHeartbeat = setInterval(() => {
        this.gateway?.send(JSON.stringify({ op: 1, d: payload.s ?? null }));
      }, intervalMs);
      this.gateway?.send(
        JSON.stringify({
          op: 2,
          d: {
            token: this.config.botToken,
            intents: 37_376,
            properties: { os: "codexclaw", browser: "codexclaw", device: "codexclaw" }
          }
        })
      );
      return;
    }
    if (payload.op === 0 && payload.t === "MESSAGE_CREATE") {
      await this.processGatewayMessage(payload.d as DiscordGatewayMessage);
    }
  }

  private async processCommandInteraction(interaction: DiscordInteraction, user: DiscordUser): Promise<void> {
    const channelId = interaction.channel_id;
    const command = interaction.data?.name;
    if (!channelId || !command) {
      await this.safeInteractionReply(interaction, "Discord command was missing routing data.", true);
      return;
    }

    await this.safeDeferInteraction(interaction);
    const text = formatSlashCommand(command, interaction.data?.options ?? []);
    this.messages.push({
      id: discordInteractionMessageId(interaction.id),
      userKey: discordUserKey(user.id),
      channel: this.name,
      text,
      receivedAt: this.now().toISOString(),
      channelThreadKey: discordChannelThreadKey(channelId)
    });
  }

  private async tryProcessTextApproval(
    message: DiscordGatewayMessage,
    author: DiscordUser,
    text: string
  ): Promise<boolean> {
    const parsed = parseTextApprovalDecision(text);
    if (!parsed) return false;

    const matches = this.findPendingApprovals(author.id, message.channel_id);
    if (matches.length === 0) return false;
    if (matches.length > 1) {
      await this.api.sendMessage({
        channel_id: message.channel_id,
        content: "Multiple approvals are pending here. Use the buttons on the approval message."
      });
      return true;
    }
    const pending = matches[0]!;
    if (this.isExpired(pending.request.expiresAt)) {
      this.pendingApprovals.delete(pending.key);
      await this.api.sendMessage({ channel_id: message.channel_id, content: "Approval expired." });
      return true;
    }
    if (parsed.decision === "modify" && !parsed.modifyText) {
      await this.api.sendMessage({
        channel_id: message.channel_id,
        content: "Usage: `3 <instruction>` or `:modify <instruction>`."
      });
      return true;
    }

    this.pendingApprovals.delete(pending.key);
    this.approvals.push(this.buildApprovalResponse(pending, parsed.decision, parsed.modifyText));
    return true;
  }

  private tryProcessTextBranchSuggestion(
    message: DiscordGatewayMessage,
    author: DiscordUser,
    text: string
  ): boolean {
    const decision = parseTextBranchSuggestionDecision(text);
    if (!decision) return false;

    const pending = this.findPendingBranchSuggestion(author.id, message.channel_id);
    if (!pending) return false;
    if (this.isExpired(pending.request.expiresAt)) {
      this.clearBranchSuggestion(pending.key, pending);
      return true;
    }

    this.clearBranchSuggestion(pending.key, pending);
    this.branchSuggestions.push({
      suggestionId: pending.request.suggestionId,
      userKey: pending.request.userKey,
      channelThreadKey: pending.request.channelThreadKey,
      decision,
      receivedAt: this.now().toISOString()
    });
    return true;
  }

  private async processComponentInteraction(interaction: DiscordInteraction, user: DiscordUser): Promise<void> {
    const data = parseCustomId(interaction.data?.custom_id);
    if (!data) {
      await this.safeInteractionReply(interaction, "Unknown or expired action.", true);
      return;
    }
    if (data.kind === "approval") {
      await this.processApprovalComponent(interaction, user, data.key, data.action);
      return;
    }
    await this.processBranchComponent(interaction, user, data.key, data.action);
  }

  private async processApprovalComponent(
    interaction: DiscordInteraction,
    user: DiscordUser,
    key: string,
    action: ApprovalDecision
  ): Promise<void> {
    const pending = this.pendingApprovals.get(key);
    if (!pending) {
      await this.safeInteractionReply(interaction, "Approval expired or unknown.", true);
      return;
    }
    if (!this.interactionMatchesPending(interaction, user, pending)) {
      await this.safeInteractionReply(interaction, "Approval belongs to another channel or user.", true);
      return;
    }
    if (this.isExpired(pending.request.expiresAt)) {
      this.pendingApprovals.delete(key);
      await this.safeInteractionReply(interaction, "Approval expired.", true);
      return;
    }

    if (action === "modify") {
      this.pendingApprovals.delete(key);
      this.approvals.push(this.buildApprovalResponse(pending, "modify"));
      await this.api.createInteractionResponse(interaction.id, interaction.token, {
        type: 9,
        data: {
          custom_id: modifyModalCustomId(key),
          title: "Modify approval",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "modify_text",
                  label: "Modified instruction",
                  style: 2,
                  min_length: 1,
                  max_length: 1900,
                  required: true
                }
              ]
            }
          ]
        }
      });
      this.pendingApprovals.set(key, pending);
      return;
    }

    this.pendingApprovals.delete(key);
    this.approvals.push(this.buildApprovalResponse(pending, action));
    await this.safeInteractionReply(interaction, action === "approve" ? "Approved." : "Rejected.", true);
  }

  private async processModalSubmitInteraction(interaction: DiscordInteraction, user: DiscordUser): Promise<void> {
    const key = parseModifyModalCustomId(interaction.data?.custom_id);
    const pending = key ? this.pendingApprovals.get(key) : undefined;
    if (!key || !pending) {
      await this.safeInteractionReply(interaction, "Modify expired or unknown.", true);
      return;
    }
    if (!this.interactionMatchesPending(interaction, user, pending, false)) {
      await this.safeInteractionReply(interaction, "Modify belongs to another channel or user.", true);
      return;
    }
    if (this.isExpired(pending.request.expiresAt)) {
      this.pendingApprovals.delete(key);
      await this.safeInteractionReply(interaction, "Modify expired.", true);
      return;
    }
    const modifyText = extractModalText(interaction.data?.components).trim();
    if (!modifyText) {
      await this.safeInteractionReply(interaction, "Modified instruction cannot be empty.", true);
      return;
    }
    this.pendingApprovals.delete(key);
    this.approvals.push(this.buildApprovalResponse(pending, "modify", modifyText));
    await this.safeInteractionReply(interaction, "Modified instruction received.", true);
  }

  private async processBranchComponent(interaction: DiscordInteraction, user: DiscordUser, key: string, action: "new" | "continue"): Promise<void> {
    const pending = this.pendingBranchSuggestions.get(key);
    if (!pending) {
      await this.safeInteractionReply(interaction, "Suggestion expired or unknown.", true);
      return;
    }
    if (pending.userId !== user.id || pending.channelId !== interaction.channel_id || pending.messageId !== interaction.message?.id) {
      await this.safeInteractionReply(interaction, "Suggestion belongs to another channel or user.", true);
      return;
    }
    if (this.isExpired(pending.request.expiresAt)) {
      this.clearBranchSuggestion(key, pending);
      await this.safeInteractionReply(interaction, "Suggestion expired.", true);
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
    await this.safeInteractionReply(interaction, action === "new" ? "Starting a new thread." : "Continuing here.", true);
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

  private findPendingApprovals(userId: string, channelId: string): PendingApproval[] {
    return [...this.pendingApprovals.values()].filter((pending) => pending.userId === userId && pending.channelId === channelId);
  }

  private findPendingBranchSuggestion(userId: string, channelId: string): PendingBranchSuggestion | undefined {
    return [...this.pendingBranchSuggestions.values()].find(
      (pending) => pending.userId === userId && pending.channelId === channelId
    );
  }

  private interactionMatchesPending(
    interaction: DiscordInteraction,
    user: DiscordUser,
    pending: PendingApproval,
    requireMessage = true
  ): boolean {
    return (
      user.id === pending.userId &&
      interaction.channel_id === pending.channelId &&
      (!requireMessage || interaction.message?.id === pending.messageId)
    );
  }

  private normalizeGatewayText(message: DiscordGatewayMessage): string | undefined {
    const content = message.content?.trim();
    if (!content) return undefined;
    if (!message.guild_id) return content;

    const mentionPattern = new RegExp(`^<@!?${escapeRegExp(this.config.applicationId)}>\\s*`);
    if (!mentionPattern.test(content)) return undefined;
    const normalized = content.replace(mentionPattern, "").trim();
    return normalized || undefined;
  }

  private async safeInteractionReply(interaction: DiscordInteraction, content: string, ephemeral = false): Promise<void> {
    await this.api.createInteractionResponse(interaction.id, interaction.token, {
      type: 4,
      data: {
        content,
        flags: ephemeral ? 64 : undefined
      }
    });
  }

  private async safeDeferInteraction(interaction: DiscordInteraction): Promise<void> {
    await this.api.createInteractionResponse(interaction.id, interaction.token, { type: 5, data: { flags: 64 } });
  }

  private isExpired(expiresAt: string): boolean {
    return this.now().toISOString() > expiresAt;
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

  private async bufferDelta(channelId: string, message: OutboundMessage): Promise<void> {
    const existing = this.deltaBuffers.get(channelId);
    if (existing) existing.text += message.text;
    else {
      this.deltaBuffers.set(channelId, {
        channelId,
        userKey: message.userKey,
        channelThreadKey: message.channelThreadKey,
        text: message.text
      });
    }

    const buffer = this.deltaBuffers.get(channelId);
    if (!buffer) return;
    if (this.config.deltaFlushMs === 0) {
      await this.flushDeltaKey(channelId);
      return;
    }
    if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        void this.flushDeltaKey(channelId);
      }, this.config.deltaFlushMs);
    }
  }

  private async flushDeltasFor(channelId: string): Promise<void> {
    await this.flushDeltaKey(channelId);
  }

  private async flushDeltaKey(key: string): Promise<void> {
    const buffer = this.deltaBuffers.get(key);
    if (!buffer) return;
    this.deltaBuffers.delete(key);
    if (buffer.timer) clearTimeout(buffer.timer);
    if (!buffer.text) return;
    await this.sendChunked(buffer.channelId, buffer.text);
  }

  private async sendChunked(channelId: string, text: string, replyTo?: string): Promise<ChannelSendResult> {
    let first: ChannelMessageId | undefined;
    for (const chunk of chunkText(text, SAFE_CHUNK_LIMIT)) {
      const sent = await this.api.sendMessage({
        channel_id: channelId,
        content: chunk,
        message_reference: replyTo ? { message_id: replyTo, channel_id: channelId } : undefined
      });
      first ??= discordMessageId(sent.channel_id, sent.id);
      replyTo = undefined;
    }
    return { channelMessageId: first };
  }

  private async resolveChannelId(message: Pick<OutboundMessage, "channelThreadKey" | "userKey">): Promise<string> {
    if (message.channelThreadKey) return parseDiscordChannelThreadKey(message.channelThreadKey);
    const dm = await this.api.createDmChannel(parseDiscordUserKey(message.userKey));
    return dm.id;
  }

  private isAllowedUser(userId: string): boolean {
    return this.config.allowAllUsersForLocalDev || this.allowedUserIds.has(userId);
  }

  private isAllowedGuild(guildId: string | undefined): boolean {
    return !guildId || this.allowedGuildIds.size === 0 || this.allowedGuildIds.has(guildId);
  }

  private hasProcessedInteraction(interactionId: string): boolean {
    this.expireProcessedInteractions();
    return this.processedInteractions.has(interactionId);
  }

  private rememberInteraction(interactionId: string): void {
    this.processedInteractions.set(interactionId, this.now().getTime() + INTERACTION_REPLAY_WINDOW_MS);
  }

  private expireProcessedInteractions(): void {
    const nowMs = this.now().getTime();
    for (const [interactionId, expiresAt] of this.processedInteractions) {
      if (expiresAt <= nowMs) this.processedInteractions.delete(interactionId);
    }
  }
}

export function createDiscordChannelAdapter(options: DiscordAdapterOptions): DiscordChannelAdapter {
  return new DiscordChannelAdapter(options);
}

export function verifyDiscordInteractionSignature(input: {
  publicKeyHex: string;
  timestamp: string;
  body: Uint8Array;
  signatureHex: string;
  now?: Date;
  replayWindowMs?: number;
}): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(input.publicKeyHex) || !/^[0-9a-fA-F]{128}$/.test(input.signatureHex)) return false;
  const signedAtMs = Number.parseInt(input.timestamp, 10) * 1000;
  if (!Number.isFinite(signedAtMs)) return false;
  if (Math.abs((input.now ?? new Date()).getTime() - signedAtMs) > (input.replayWindowMs ?? INTERACTION_REPLAY_WINDOW_MS)) {
    return false;
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.publicKeyHex, "hex")]),
    format: "der",
    type: "spki"
  });
  const message = Buffer.concat([Buffer.from(input.timestamp, "utf8"), Buffer.from(input.body)]);
  return verifySignature(null, message, key, Buffer.from(input.signatureHex, "hex"));
}

function formatApprovalPrompt(request: ChannelApprovalRequest): string {
  return [
    `Approval requested`,
    "",
    request.prompt,
    "",
    "Reply `1` to approve, `2` to reject, or `3 <instruction>` to modify.",
    `Expires at: ${request.expiresAt}`
  ].join("\n");
}

function formatBranchSuggestionPrompt(text: string): string {
  return `${text}\n\nReply \`1\` for New thread or \`2\` to Continue.`;
}

function parseTextApprovalDecision(text: string): { decision: ApprovalDecision; modifyText?: string } | undefined {
  const match = /^(?:[:]?)?(approve|reject|modify|a|y|yes|r|n|no|m|1|2|3)(?:\s+([\s\S]+))?$/i.exec(text.trim());
  if (!match) return undefined;
  const raw = match[1]?.toLowerCase();
  const modifyText = match[2]?.trim();
  if (raw === "1" || raw === "approve" || raw === "a" || raw === "y" || raw === "yes") return { decision: "approve" };
  if (raw === "2" || raw === "reject" || raw === "r" || raw === "n" || raw === "no") return { decision: "reject" };
  if (raw === "3" || raw === "modify" || raw === "m") return { decision: "modify", modifyText };
  return undefined;
}

function parseTextBranchSuggestionDecision(text: string): BranchSuggestionDecision | undefined {
  const normalized = text.trim().toLowerCase();
  if (normalized === "1" || normalized === "new" || normalized === "new thread" || normalized === ":new") return "new_thread";
  if (normalized === "2" || normalized === "continue" || normalized === "cont" || normalized === ":continue") return "continue";
  return undefined;
}

async function readLimitedRequestBody(request: Request, limitBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

class BodyTooLargeError extends Error {}

function formatSlashCommand(command: string, options: readonly DiscordCommandOption[]): string {
  const args = flattenCommandOptions(options).join(" ");
  return args ? `/${command} ${args}` : `/${command}`;
}

function normalizeDiscordTextCommandAlias(text: string): string {
  return text.replace(/^:([a-z][a-z0-9_-]*)(?=\s|$)/i, "/$1");
}

function flattenCommandOptions(options: readonly DiscordCommandOption[]): string[] {
  const result: string[] = [];
  for (const option of options) {
    if (option.value !== undefined) result.push(String(option.value));
    if (option.options) result.push(...flattenCommandOptions(option.options));
  }
  return result;
}

function buttonRow(buttons: readonly Extract<DiscordComponent, { type: 2 }>[]): DiscordActionRow {
  return { type: 1, components: buttons };
}

function approvalCustomId(key: string, action: ApprovalDecision): string {
  return `cc:a:${key}:${action}`;
}

function branchCustomId(key: string, action: "new" | "continue"): string {
  return `cc:b:${key}:${action}`;
}

function modifyModalCustomId(key: string): string {
  return `cc:m:${key}`;
}

function parseModifyModalCustomId(customId: string | undefined): string | undefined {
  const parts = customId?.split(":");
  return parts?.length === 3 && parts[0] === "cc" && parts[1] === "m" ? parts[2] : undefined;
}

function parseCustomId(customId: string | undefined):
  | { kind: "approval"; key: string; action: ApprovalDecision }
  | { kind: "branch"; key: string; action: "new" | "continue" }
  | undefined {
  const parts = customId?.split(":");
  if (!parts || parts.length !== 4 || parts[0] !== "cc") return undefined;
  if (parts[1] === "a" && isApprovalDecision(parts[3])) return { kind: "approval", key: parts[2], action: parts[3] };
  if (parts[1] === "b" && (parts[3] === "new" || parts[3] === "continue")) {
    return { kind: "branch", key: parts[2], action: parts[3] };
  }
  return undefined;
}

function extractModalText(rows: readonly DiscordActionRow[] | undefined): string {
  for (const row of rows ?? []) {
    for (const component of row.components) {
      if (component.type === 4 && component.custom_id === "modify_text" && "value" in component) {
        return String(component.value);
      }
    }
  }
  return "";
}

function isApprovalDecision(value: string): value is ApprovalDecision {
  return value === "approve" || value === "reject" || value === "modify";
}

function discordUserKey(userId: string): UserKey {
  return `discord:${userId}`;
}

function discordChannelThreadKey(channelId: string): string {
  return `discord:${channelId}`;
}

function discordMessageId(channelId: string, messageId: string): ChannelMessageId {
  return `discord:${channelId}:${messageId}`;
}

function discordInteractionMessageId(interactionId: string): ChannelMessageId {
  return `discord:interaction:${interactionId}`;
}

function parseDiscordUserKey(userKey: UserKey): string {
  const match = /^discord:(\d+)$/.exec(userKey);
  if (!match) throw new Error(`Invalid Discord user key: ${userKey}`);
  return match[1];
}

function parseDiscordChannelThreadKey(channelThreadKey: string): string {
  const match = /^discord:(\d+)$/.exec(channelThreadKey);
  if (!match) throw new Error(`Invalid Discord channel thread key: ${channelThreadKey}`);
  return match[1];
}

function parseDiscordMessageId(channelMessageId: ChannelMessageId | undefined): string | undefined {
  const match = channelMessageId ? /^discord:\d+:(\d+)$/.exec(channelMessageId) : undefined;
  return match?.[1];
}

function chunkText(text: string, limit: number): readonly string[] {
  if (text.length <= DISCORD_MESSAGE_LIMIT && text.length <= limit) return [text || " "];

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
