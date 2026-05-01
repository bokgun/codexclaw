import { randomUUID } from "node:crypto";
import { stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { createJsonLineLogger, type RuntimeLogger } from "../runtime/log.js";
import type {
  ApprovalDecision,
  ChannelAdapter,
  ChannelApprovalPrompt,
  ChannelApprovalRequest,
  ChannelApprovalResponse,
  ChannelSendResult,
  NormalizedMessage,
  OutboundMessage,
  ParsedChannelInput
} from "./types.js";
import { parseSlashCommand } from "./commands.js";

export interface CliAdapterOptions {
  userKey?: string;
  channelThreadKey?: string;
  input?: Readable;
  output?: Writable;
  prompt?: string;
  logger?: RuntimeLogger;
  now?: () => Date;
  idFactory?: () => string;
}

export class CliChannelAdapter implements ChannelAdapter {
  readonly name = "cli" as const;
  readonly receive: AsyncIterable<NormalizedMessage>;
  readonly approvalResponses: AsyncIterable<ChannelApprovalResponse>;

  private readonly userKey: string;
  private readonly channelThreadKey: string;
  private readonly output: Writable;
  private readonly prompt: string;
  private readonly logger: RuntimeLogger;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly repl?: Interface;
  private readonly pendingApprovals = new Map<string, ChannelApprovalRequest>();
  private readonly messageQueue = new AsyncQueue<NormalizedMessage>();
  private readonly approvalQueue = new AsyncQueue<ChannelApprovalResponse>();

  constructor(options: CliAdapterOptions = {}) {
    this.userKey = options.userKey ?? defaultCliUserKey();
    this.channelThreadKey = options.channelThreadKey ?? "cli:local";
    this.output = options.output ?? stdout;
    this.prompt = options.prompt ?? "codexclaw> ";
    this.logger = options.logger ?? createJsonLineLogger();
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());

    if (options.input) {
      this.repl = createInterface({ input: options.input, output: this.output });
      this.receive = this.messageQueue;
      this.approvalResponses = this.approvalQueue;
      void this.pumpInput();
    } else {
      this.receive = emptyAsyncIterable();
      this.approvalResponses = emptyAsyncIterable();
    }
  }

  parseInput(text: string): ParsedChannelInput | { kind: "error"; error: string } | undefined {
    if (!text.trim()) return undefined;

    const parsed = parseSlashCommand(text);
    if (parsed.error) return { kind: "error", error: parsed.error };
    if (parsed.command) return { kind: "command", command: parsed.command };

    return {
      kind: "message",
      message: this.normalizeMessage(text)
    };
  }

  async send(message: OutboundMessage): Promise<ChannelSendResult> {
    this.output.write(`${message.text}\n`);
    return { channelMessageId: this.idFactory() };
  }

  async requestApproval(request: ChannelApprovalRequest): Promise<ChannelApprovalPrompt> {
    const channelMessageId = request.approvalId;
    this.pendingApprovals.set(request.approvalId, request);
    this.output.write(
      [
        "",
        `Approval requested (${request.approvalId})`,
        request.prompt,
        "Choose: approve, reject, or modify.",
        `Respond with: /approve ${request.approvalId}, /reject ${request.approvalId}, or /modify ${request.approvalId} <instruction>`,
        ""
      ].join("\n")
    );
    this.logger.info("approval_prompt_sent", {
      channel: this.name,
      userKey: request.userKey,
      threadId: request.threadId,
      approvalId: request.approvalId,
      channelMessageId,
      expiresAt: request.expiresAt
    });
    return { approvalId: request.approvalId, channelMessageId };
  }

  async acknowledge(): Promise<void> {
    return;
  }

  close(): void {
    this.repl?.close();
    this.messageQueue.close();
    this.approvalQueue.close();
  }

  private async pumpInput(): Promise<void> {
    if (!this.repl) return;

    try {
      for (;;) {
        const line = await readLine(this.repl, this.prompt);
        if (line === undefined) return;

        const approval = this.parseApprovalLine(line);
        if (approval) {
          this.approvalQueue.push(approval);
          continue;
        }

        const parsed = this.parseInput(line);
        if (!parsed) continue;
        if (parsed.kind === "error") {
          await this.send({
            channel: this.name,
            userKey: this.userKey,
            text: parsed.error,
            channelThreadKey: this.channelThreadKey
          });
          continue;
        }
        if (parsed.kind === "command") {
          this.messageQueue.push(this.normalizeMessage(line));
          continue;
        }

        this.messageQueue.push(parsed.message);
      }
    } finally {
      this.messageQueue.close();
      this.approvalQueue.close();
    }
  }

  private parseApprovalLine(line: string): ChannelApprovalResponse | undefined {
    const trimmed = line.trim();
    const match = /^\/(approve|reject|modify)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
    if (!match) return undefined;

    const rawDecision = match[1];
    const approvalId = match[2];
    const modifyText = match[3];
    if (!approvalId) return undefined;

    const request = this.pendingApprovals.get(approvalId);
    const decision = readApprovalDecision(rawDecision);
    if (!request || !decision) {
      this.logger.warn("approval_response_unmatched", {
        channel: this.name,
        userKey: this.userKey,
        approvalId
      });
      return undefined;
    }

    if (decision === "modify" && !modifyText?.trim()) {
      this.output.write("usage: /modify <approval-id> <instruction>\n");
      return undefined;
    }

    this.pendingApprovals.delete(approvalId);
    return {
      approvalId,
      channelMessageId: request.channelThreadKey ? approvalId : request.approvalId,
      userKey: request.userKey,
      decision,
      modifyText: decision === "modify" ? modifyText?.trim() : undefined,
      receivedAt: this.now().toISOString(),
      channelThreadKey: request.channelThreadKey
    };
  }

  private normalizeMessage(text: string): NormalizedMessage {
    return {
      id: this.idFactory(),
      userKey: this.userKey,
      channel: this.name,
      text,
      receivedAt: this.now().toISOString(),
      channelThreadKey: this.channelThreadKey
    };
  }
}

export function createCliChannelAdapter(options: CliAdapterOptions = {}): CliChannelAdapter {
  return new CliChannelAdapter(options);
}

function defaultCliUserKey(): string {
  const user = process.env.USER || process.env.USERNAME || "local";
  return `cli:${user}`;
}

function readApprovalDecision(value: string | undefined): ApprovalDecision | undefined {
  if (value === "approve") return "approve";
  if (value === "reject") return "reject";
  if (value === "modify") return "modify";
  return undefined;
}

async function readLine(repl: Interface, prompt: string): Promise<string | undefined> {
  try {
    return await repl.question(prompt);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ERR_USE_AFTER_CLOSE") {
      return undefined;
    }
    throw error;
  }
}

async function* emptyAsyncIterable<T>(): AsyncIterable<T> {}

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
