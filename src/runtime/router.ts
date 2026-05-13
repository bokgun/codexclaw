import type { CodexRuntimeClient } from "../codex/runtime-client.js";
import { attachPrefsToText } from "../codex/input.js";
import { attachWikiContextToText } from "../wiki/context.js";
import { parseSchedule } from "./schedule.js";
import { isValidPluginId, type PluginCommandService } from "../plugins/index.js";
import type { SkillInspectionService } from "../skills/index.js";
import type { ThreadManager } from "../thread/thread-manager.js";
import type { PointerStore } from "../store/pointer-store.js";
import { RoutingError } from "./errors.js";
import type { ChannelName, ChannelSink, InboundMessage, PrefKey, RuntimeEvent, TaskRunStatus, ThreadRecord } from "./types.js";
import { TurnQueue } from "./turn-queue.js";

export interface RouterOptions {
  bindThread?: (thread: ThreadRecord, message: InboundMessage) => void;
  prepareTurnText?: (input: { text: string; message: InboundMessage }) => string;
  store?: PointerStore;
  wiki?: WikiCommandService;
  channel?: ChannelName;
  minScheduleIntervalMs?: number;
  defaultTaskRetry?: number;
  defaultTaskTimeoutSec?: number;
  skills?: SkillInspectionService;
  plugins?: PluginCommandService;
}

export interface WikiCommandService {
  ingestFiles(input: {
    userKey: string;
    paths: readonly string[];
    visibility: "project_public" | "user_private";
    slug?: string;
    focus?: string;
  }): Promise<{ pagePath: string; manifestPath: string; sourceCount: number }>;
  addNote(input: {
    userKey: string;
    title: string;
    body: string;
    visibility: "project_public" | "user_private";
  }): Promise<{ pagePath: string; manifestPath: string }>;
  captureSelected(input: {
    userKey: string;
    text: string;
    visibility: "project_public" | "user_private";
    slug?: string;
  }): Promise<{ pagePath: string; manifestPath: string }>;
  query(input: { userKey: string; query: string; limit?: number }): Promise<readonly WikiCommandQueryResult[]>;
  lint(input: { userKey: string; writeReport: boolean }): Promise<{ findings: readonly WikiCommandLintFinding[]; reportPath?: string }>;
}

export interface WikiCommandQueryResult {
  pagePath: string;
  title: string;
  excerpt: string;
  sourceRefs?: readonly { displayPath: string; lineStart?: number; lineEnd?: number }[];
}

export interface WikiCommandLintFinding {
  severity: "error" | "warning" | "info";
  kind: string;
  pagePath: string;
  message: string;
}

export interface ScheduledRouteInput {
  taskId: string;
  userKey: string;
  channel: ChannelName;
  channelThreadKey?: string;
  label: string;
  text: string;
  timeoutSec: number;
}

export interface ScheduledRouteResult {
  taskId: string;
  threadId?: string;
  turnId?: string;
  status: Exclude<TaskRunStatus, "skipped_dedupe" | "skipped_channel">;
  reason?: string;
}

interface ScheduledWaiter {
  turnId?: string;
  resolve(event: Extract<RuntimeEvent, { kind: "turn_completed" | "turn_failed" }>): void;
  reject(error: Error): void;
}

export class Router {
  private readonly queue = new TurnQueue();
  private connected = true;

  constructor(
    private readonly threads: ThreadManager,
    private readonly codex: CodexRuntimeClient,
    private readonly channel: ChannelSink,
    private readonly options: RouterOptions = {}
  ) {}

  async receive(message: InboundMessage): Promise<void> {
    const text = message.text.trim();
    if (!text) return;

    try {
      if (text.startsWith("/")) {
        await this.handleCommand(message, text);
        return;
      }

      if (!this.connected) throw new RoutingError("Codex app-server is disconnected; wait for reconnect before sending more work.", "disconnected");
      const thread = await this.threads.resolveRoutableThread(message.userKey);
      if (this.queue.isBusy(thread.threadId)) {
        await this.channel.send({
          kind: "status",
          channel: message.channel,
          userKey: message.userKey,
          channelThreadKey: message.channelThreadKey,
          text: `Queued for '${thread.label}' because a turn is already running.`
        });
      }

      const turnText = this.prepareTurnText(this.attachPrefs(message.userKey, message.text), message);
      await this.enqueueFollowUp(thread, turnText, message);
    } catch (error) {
      await this.channel.send({
        kind: "text",
        channel: message.channel,
        userKey: message.userKey,
        channelThreadKey: message.channelThreadKey,
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async routeScheduled(input: ScheduledRouteInput): Promise<ScheduledRouteResult> {
    try {
      if (!this.connected) {
        return { taskId: input.taskId, status: "failed", reason: "Codex app-server is disconnected." };
      }

      const thread = await this.threads.resolveTaskThread(input.userKey, input.label);
      const scheduledMessage = {
        channel: input.channel,
        channelMessageId: `task:${input.taskId}`,
        userKey: input.userKey,
        text: input.text,
        receivedAt: new Date().toISOString(),
        channelThreadKey: input.channelThreadKey
      };

      return await this.queue.enqueue(thread.threadId, async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let turnId: string | undefined;
        let pendingTerminal: Extract<RuntimeEvent, { kind: "turn_completed" | "turn_failed" }> | undefined;
        try {
          this.options.bindThread?.(thread, scheduledMessage);
          await this.threads.resumeThread(thread);
          let timedOut = false;
          let abortScheduled!: (error: Error) => void;
          const aborted = new Promise<Error>((resolve) => {
            abortScheduled = resolve;
          });
          const timeoutReached = new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              timedOut = true;
              resolve();
            }, input.timeoutSec * 1000);
          });
          const terminal = new Promise<ScheduledRouteResult>((resolve) => {
            const resolveEvent = (event: Extract<RuntimeEvent, { kind: "turn_completed" | "turn_failed" }>): void => {
              resolve({
                taskId: input.taskId,
                threadId: thread.threadId,
                turnId: event.turnId,
                status: event.kind === "turn_completed" ? "succeeded" : "failed",
                reason: event.kind === "turn_failed" ? event.error ?? "Scheduled turn failed." : undefined
              });
            };
            this.scheduledWaiters.set(thread.threadId, {
              turnId,
              reject: (error) => {
                abortScheduled(error);
                resolve({
                  taskId: input.taskId,
                  threadId: thread.threadId,
                  turnId,
                  status: "failed",
                  reason: error.message
                });
              },
              resolve: (event) => {
                if (!turnId) {
                  pendingTerminal = event;
                  return;
                }
                if (event.turnId !== turnId) return;
                resolveEvent(event);
              }
            });
            if (pendingTerminal && pendingTerminal.turnId === turnId) resolveEvent(pendingTerminal);
          });
          const started = this.codex.startTurn(thread.threadId, this.attachPrefs(input.userKey, input.text)).then((startedTurnId) => {
            turnId = startedTurnId;
            if (timedOut) {
              if (startedTurnId) void this.codex.interruptTurn(thread.threadId, startedTurnId).catch(() => undefined);
              return startedTurnId;
            }
            const waiter = this.scheduledWaiters.get(thread.threadId);
            if (waiter) waiter.turnId = startedTurnId;
            this.threads.markRouted(thread);
            if (pendingTerminal && pendingTerminal.turnId === turnId) {
              this.scheduledWaiters.get(thread.threadId)?.resolve(pendingTerminal);
            }
            return startedTurnId;
          });
          await Promise.race([started, timeoutReached]);
          if (timedOut && !turnId) {
            void started.catch(() => undefined);
            this.threads.quarantineThread(thread, "scheduled_start_timeout");
            return {
              taskId: input.taskId,
              threadId: thread.threadId,
              status: "timed_out",
              reason: "Scheduled turn timed out before start was acknowledged."
            };
          }
          if (timedOut && turnId) {
            await this.codex.interruptTurn(thread.threadId, turnId).catch(() => undefined);
            return {
              taskId: input.taskId,
              threadId: thread.threadId,
              turnId,
              status: "timed_out",
              reason: "Scheduled turn timed out."
            };
          }
          const result = await Promise.race([
            terminal,
            timeoutReached.then((): ScheduledRouteResult => ({
              taskId: input.taskId,
              threadId: thread.threadId,
              turnId,
              status: "timed_out",
              reason: "Scheduled turn timed out."
            }))
          ]);
          if (result.status === "timed_out" && turnId) await this.codex.interruptTurn(thread.threadId, turnId).catch(() => undefined);
          return { ...result, turnId: result.turnId ?? turnId };
        } catch (error) {
          return {
            taskId: input.taskId,
            threadId: thread.threadId,
            turnId,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error)
          };
        } finally {
          if (timeout) clearTimeout(timeout);
          this.scheduledWaiters.delete(thread.threadId);
        }
      });
    } catch (error) {
      return {
        taskId: input.taskId,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  isThreadBusy(threadId: string): boolean {
    return this.queue.isBusy(threadId);
  }

  busyThreadIds(): string[] {
    return this.queue.busyThreadIds();
  }

  abortThread(threadId: string, reason: string): void {
    const waiter = this.scheduledWaiters.get(threadId);
    if (waiter) {
      this.scheduledWaiters.delete(threadId);
      waiter.reject(new Error(reason));
    }
    this.queue.abortThread(threadId, reason);
  }

  enqueueFollowUp(thread: ThreadRecord, text: string, message?: InboundMessage): Promise<void> {
    return this.queue.enqueue(thread.threadId, async () => {
      if (message) this.options.bindThread?.(thread, message);
      await this.threads.resumeThread(thread);
      const turnId = await this.codex.startTurn(thread.threadId, text);
      this.threads.markRouted(thread);
      await this.queue.waitForTerminal(thread.threadId, turnId);
    });
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.kind === "skills_changed") {
      this.options.skills?.invalidateCodexSkills();
      return;
    }
    if (event.kind === "turn_completed" || event.kind === "turn_failed") {
      if (event.threadId) this.scheduledWaiters.get(event.threadId)?.resolve(event);
      if (event.threadId) this.queue.resolveTerminal(event.threadId, event.turnId);
    }
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  private async handleCommand(message: InboundMessage, text: string): Promise<void> {
    const [command, ...args] = text.split(/\s+/);
    const label = args.join(" ").trim();

    switch (command) {
      case "/thread": {
        await this.handleThreadCommand(message, args);
        return;
      }
      case "/new": {
        const thread = await this.threads.createThread(message.userKey, label || undefined);
        await this.sendText(message, `Created and switched to '${thread.label}'.`);
        return;
      }
      case "/threads": {
        const threads = this.threads.listThreads(message.userKey);
        await this.sendText(
          message,
          threads.length === 0
            ? "No known threads."
            : threads.map((thread) => `${thread.isActive ? "*" : " "} ${thread.label} ${thread.status}`).join("\n")
        );
        return;
      }
      case "/switch": {
        if (!label) throw new RoutingError("Usage: /switch <label>", "invalid_command");
        const thread = await this.threads.switchThread(message.userKey, label);
        await this.sendText(message, `Switched to '${thread.label}'.`);
        return;
      }
      case "/branch": {
        const thread = await this.threads.branchThread(message.userKey, label || `branch-${Date.now()}`);
        await this.sendText(message, `Branched and switched to '${thread.label}'.`);
        return;
      }
      case "/archive": {
        if (!label) throw new RoutingError("Usage: /archive <label>", "invalid_command");
        const thread = await this.threads.archiveThread(message.userKey, label);
        await this.sendText(message, `Archived '${thread.label}'.`);
        return;
      }
      case "/tasks":
        await this.handleTasksCommand(message, args);
        return;
      case "/prefs":
        await this.handlePrefsCommand(message, args);
        return;
      case "/wiki":
        await this.handleWikiCommand(message, args);
        return;
      case "/skills":
        await this.handleSkillsCommand(message, args);
        return;
      case "/plugin":
        await this.handlePluginCommand(message, args);
        return;
      case "/skill":
        throw new RoutingError("Usage: /skills list", "invalid_command");
      default:
        throw new RoutingError(`Unknown command '${command}'.`, "invalid_command");
    }
  }

  private readonly scheduledWaiters = new Map<string, ScheduledWaiter>();

  private async handleThreadCommand(message: InboundMessage, args: string[]): Promise<void> {
    const action = args[0];
    const label = args.slice(1).join(" ").trim();
    if (action === "new") {
      const thread = await this.threads.createThread(message.userKey, label || undefined);
      await this.sendText(message, `Created and switched to '${thread.label}'.`);
      return;
    }
    if (action === "list" || action === "ls") {
      const threads = this.threads.listThreads(message.userKey);
      await this.sendText(
        message,
        threads.length === 0
          ? "No known threads."
          : threads.map((thread) => `${thread.isActive ? "*" : " "} ${thread.label} ${thread.status}`).join("\n")
      );
      return;
    }
    if (action === "switch") {
      if (!label) throw new RoutingError("Usage: /thread switch <label>", "invalid_command");
      const thread = await this.threads.switchThread(message.userKey, label);
      await this.sendText(message, `Switched to '${thread.label}'.`);
      return;
    }
    if (action === "branch") {
      const thread = await this.threads.branchThread(message.userKey, label || `branch-${Date.now()}`);
      await this.sendText(message, `Branched and switched to '${thread.label}'.`);
      return;
    }
    if (action === "archive") {
      if (!label) throw new RoutingError("Usage: /thread archive <label>", "invalid_command");
      const thread = await this.threads.archiveThread(message.userKey, label);
      await this.sendText(message, `Archived '${thread.label}'.`);
      return;
    }
    throw new RoutingError("Usage: /thread new|list|switch|branch|archive", "invalid_command");
  }

  private async handleTasksCommand(message: InboundMessage, args: string[]): Promise<void> {
    const store = this.options.store;
    if (!store) throw new RoutingError("Tasks are not enabled in this runtime.", "capability_unavailable");
    const action = args[0];
    if (!action) throw new RoutingError("Usage: /tasks add|list|pause|reactivate|remove", "invalid_command");

    if (action === "list") {
      const tasks = store.listTasks(message.userKey);
      await this.sendText(
        message,
        tasks.length === 0
          ? "No scheduled tasks."
          : tasks
              .map(
                (task) =>
                  `${task.enabled ? "*" : " "} ${task.taskId} ${task.schedule} ${task.label} next=${task.nextRunAt} failures=${task.consecutiveFailures}`
              )
              .join("\n")
      );
      return;
    }

    if (action === "add") {
      const scheduleParts = args[1] === "every" ? 2 : looksLikeCronParts(args.slice(1, 6)) ? 5 : 1;
      const schedule = args.slice(1, 1 + scheduleParts).join(" ");
      const label = args[1 + scheduleParts];
      const taskText = args.slice(2 + scheduleParts).join(" ").trim();
      if (!schedule || !label || !taskText) {
        throw new RoutingError("Usage: /tasks add <schedule> <label> <prompt>", "invalid_command");
      }
      const parsed = parseSchedule(schedule, { minIntervalMs: this.options.minScheduleIntervalMs });
      await this.threads.resolveTaskThread(message.userKey, label);
      const task = store.createTask({
        userKey: message.userKey,
        label,
        channel: this.options.channel ?? message.channel,
        schedule: parsed.source,
        taskText,
        retry: this.options.defaultTaskRetry,
        timeoutSec: this.options.defaultTaskTimeoutSec,
        nextRunAt: parsed.nextAfter(new Date()).toISOString()
      });
      await this.sendText(message, `Created task ${task.taskId} for '${task.label}'.`);
      return;
    }

    const taskId = args[1];
    if (!taskId || args.length !== 2) throw new RoutingError(`Usage: /tasks ${action} <id>`, "invalid_command");
    const task = store.getTask(taskId);
    if (!task || task.userKey !== message.userKey) throw new RoutingError(`Unknown task '${taskId}'.`, "thread_not_found");
    if (action === "pause") {
      store.setTaskEnabled(taskId, false);
      await this.sendText(message, `Paused task ${taskId}.`);
      return;
    }
    if (action === "reactivate") {
      store.setTaskEnabled(taskId, true);
      await this.sendText(message, `Reactivated task ${taskId}.`);
      return;
    }
    if (action === "remove") {
      store.deleteTask(taskId);
      await this.sendText(message, `Removed task ${taskId}.`);
      return;
    }

    throw new RoutingError("Usage: /tasks add|list|pause|reactivate|remove", "invalid_command");
  }

  private async handlePrefsCommand(message: InboundMessage, args: string[]): Promise<void> {
    const store = this.options.store;
    if (!store) throw new RoutingError("Prefs are not enabled in this runtime.", "capability_unavailable");
    const action = args[0];
    if (action === "show") {
      const prefs = store.listPrefs(message.userKey);
      await this.sendText(
        message,
        prefs.length === 0 ? "No preferences set." : prefs.map((pref) => `${pref.key}=${pref.value}`).join("\n")
      );
      return;
    }
    if (action === "set") {
      const key = readPrefKey(args[1]);
      const value = args.slice(2).join(" ").trim();
      if (!key || !value) throw new RoutingError("Usage: /prefs set <lang|tone|verbosity> <value>", "invalid_command");
      store.setPref(message.userKey, key, value);
      await this.sendText(message, `Set ${key}.`);
      return;
    }
    if (action === "unset") {
      const key = readPrefKey(args[1]);
      if (!key || args.length !== 2) throw new RoutingError("Usage: /prefs unset <lang|tone|verbosity>", "invalid_command");
      store.unsetPref(message.userKey, key);
      await this.sendText(message, `Unset ${key}.`);
      return;
    }
    throw new RoutingError("Usage: /prefs show|set|unset", "invalid_command");
  }

  private async handleWikiCommand(message: InboundMessage, args: string[]): Promise<void> {
    const wiki = this.options.wiki;
    if (!wiki) throw new RoutingError("Wiki is not enabled in this runtime.", "capability_unavailable");
    const action = args[0];
    if (action === "ingest") {
      const parsed = parseWikiIngestArgs(args.slice(1));
      if (!parsed) throw new RoutingError("Usage: /wiki ingest [--public|--private] [--slug <slug>] <path...> [--focus <text>]", "invalid_command");
      const result = await wiki.ingestFiles({ userKey: message.userKey, ...parsed });
      await this.sendText(message, `Wiki page written: ${result.pagePath}\nManifest: ${result.manifestPath}\nSources: ${result.sourceCount}`);
      return;
    }
    if (action === "note") {
      const parsed = parseWikiNoteArgs(args.slice(1));
      if (!parsed) throw new RoutingError("Usage: /wiki note [--public|--private] <title> <body>", "invalid_command");
      const result = await wiki.addNote({ userKey: message.userKey, ...parsed });
      await this.sendText(message, `Wiki note written: ${result.pagePath}\nManifest: ${result.manifestPath}`);
      return;
    }
    if (action === "capture-selected") {
      const parsed = parseWikiCaptureArgs(args.slice(1));
      if (!parsed) throw new RoutingError("Usage: /wiki capture-selected [--public|--private] [--slug <slug>] <selected text>", "invalid_command");
      const result = await wiki.captureSelected({ userKey: message.userKey, ...parsed });
      await this.sendText(message, `Wiki capture written: ${result.pagePath}\nManifest: ${result.manifestPath}`);
      return;
    }
    if (action === "query") {
      const parsed = parseWikiQueryArgs(args.slice(1));
      if (!parsed) throw new RoutingError("Usage: /wiki query [--limit <n>] <query>", "invalid_command");
      const results = await wiki.query({ userKey: message.userKey, ...parsed });
      await this.sendText(message, formatWikiQueryResults(results));
      return;
    }
    if (action === "with") {
      const parsed = parseWikiWithArgs(args.slice(1));
      if (!parsed) throw new RoutingError("Usage: /wiki with [--limit <n>] <query> -- <message>", "invalid_command");
      if (!this.connected) throw new RoutingError("Codex app-server is disconnected; wait for reconnect before sending more work.", "disconnected");
      const results = await wiki.query({ userKey: message.userKey, query: parsed.query, limit: parsed.limit });
      const thread = await this.threads.resolveRoutableThread(message.userKey);
      const turnMessage = { ...message, text: parsed.message };
      const turnText = this.prepareTurnText(this.attachPrefs(message.userKey, attachWikiContextToText(parsed.message, results)), turnMessage);
      await this.enqueueFollowUp(thread, turnText, turnMessage);
      return;
    }
    if (action === "lint") {
      if (args.length > 2 || (args[1] && args[1] !== "--write-report")) throw new RoutingError("Usage: /wiki lint [--write-report]", "invalid_command");
      const result = await wiki.lint({ userKey: message.userKey, writeReport: args[1] === "--write-report" });
      await this.sendText(message, formatWikiLintResult(result));
      return;
    }
    throw new RoutingError("Usage: /wiki ingest|note|capture-selected|query|with|lint", "invalid_command");
  }

  private async handleSkillsCommand(message: InboundMessage, args: string[]): Promise<void> {
    if (args.length !== 1 || args[0] !== "list") throw new RoutingError("Usage: /skills list", "invalid_command");
    const skills = this.options.skills;
    if (!skills) throw new RoutingError("Skills inspection is not enabled in this runtime.", "capability_unavailable");
    await this.sendText(message, await skills.renderSkillList());
  }

  private async handlePluginCommand(message: InboundMessage, args: string[]): Promise<void> {
    const action = args[0];
    if (action === "list") {
      if (args.length !== 1) throw new RoutingError("Usage: /plugin list", "invalid_command");
      const plugins = this.requirePluginCommands();
      await this.sendText(message, await plugins.list());
      return;
    }
    if (action === "status") {
      const pluginId = args[1];
      if (args.length !== 2 || !pluginId) throw new RoutingError("Usage: /plugin status <id>", "invalid_command");
      this.requireValidPluginId(pluginId);
      const plugins = this.requirePluginCommands();
      await this.sendText(message, await plugins.status(pluginId));
      return;
    }
    if (action === "enable") {
      const pluginId = args[1];
      if (!pluginId || (args.length !== 2 && args.length !== 3)) {
        throw new RoutingError("Usage: /plugin enable <id> [--confirm]", "invalid_command");
      }
      if (args.length === 3 && args[2] !== "--confirm") {
        throw new RoutingError("Usage: /plugin enable <id> [--confirm]", "invalid_command");
      }
      this.requireValidPluginId(pluginId);
      const plugins = this.requirePluginCommands();
      await this.sendText(message, args[2] === "--confirm" ? await plugins.confirmEnable(pluginId) : await plugins.previewEnable(pluginId));
      return;
    }
    if (action === "disable") {
      const pluginId = args[1];
      if (args.length !== 2 || !pluginId) throw new RoutingError("Usage: /plugin disable <id>", "invalid_command");
      this.requireValidPluginId(pluginId);
      const plugins = this.requirePluginCommands();
      await this.sendText(message, await plugins.disable(pluginId));
      return;
    }
    throw new RoutingError("Usage: /plugin list|status|enable|disable", "invalid_command");
  }

  private requirePluginCommands(): PluginCommandService {
    const plugins = this.options.plugins;
    if (!plugins) throw new RoutingError("Plugin commands are not enabled in this runtime.", "capability_unavailable");
    return plugins;
  }

  private requireValidPluginId(pluginId: string): void {
    if (!isValidPluginId(pluginId)) throw new RoutingError("Invalid plugin id.", "invalid_command");
  }

  private attachPrefs(userKey: string, text: string): string {
    return this.options.store ? attachPrefsToText(text, this.options.store.listPrefs(userKey)) : text;
  }

  private prepareTurnText(text: string, message: InboundMessage): string {
    return this.options.prepareTurnText ? this.options.prepareTurnText({ text, message }) : text;
  }

  private async sendText(message: InboundMessage, text: string): Promise<void> {
    await this.channel.send({
      kind: "text",
      channel: message.channel,
      userKey: message.userKey,
      channelThreadKey: message.channelThreadKey,
      text
    });
  }
}

function readPrefKey(value: string | undefined): PrefKey | undefined {
  return value === "lang" || value === "tone" || value === "verbosity" ? value : undefined;
}

function parseWikiIngestArgs(args: string[]):
  | { paths: readonly string[]; visibility: "project_public" | "user_private"; slug?: string; focus?: string }
  | undefined {
  let visibility: "project_public" | "user_private" = "user_private";
  let slug: string | undefined;
  let focus: string | undefined;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--public") {
      visibility = "project_public";
      continue;
    }
    if (arg === "--private") {
      visibility = "user_private";
      continue;
    }
    if (arg === "--slug") {
      slug = args[index + 1];
      index += 1;
      if (!slug || !isValidWikiSlug(slug)) return undefined;
      continue;
    }
    if (arg === "--focus") {
      focus = args.slice(index + 1).join(" ").trim();
      if (!focus) return undefined;
      break;
    }
    if (!arg || arg.startsWith("--")) return undefined;
    paths.push(arg);
  }
  if (paths.length === 0) return undefined;
  return { paths, visibility, slug, focus };
}

function parseWikiNoteArgs(args: string[]):
  | { title: string; body: string; visibility: "project_public" | "user_private" }
  | undefined {
  let visibility: "project_public" | "user_private" = "user_private";
  const rest = [...args];
  while (rest[0] === "--public" || rest[0] === "--private") {
    visibility = rest.shift() === "--public" ? "project_public" : "user_private";
  }
  const title = rest.shift();
  const body = rest.join(" ").trim();
  if (!title || !body) return undefined;
  return { title, body, visibility };
}

function parseWikiCaptureArgs(args: string[]):
  | { text: string; visibility: "project_public" | "user_private"; slug?: string }
  | undefined {
  let visibility: "project_public" | "user_private" = "user_private";
  let slug: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--public") {
      visibility = "project_public";
      continue;
    }
    if (arg === "--private") {
      visibility = "user_private";
      continue;
    }
    if (arg === "--slug") {
      slug = args[index + 1];
      index += 1;
      if (!slug || !isValidWikiSlug(slug)) return undefined;
      continue;
    }
    rest.push(arg);
  }
  const text = rest.join(" ").trim();
  if (!text) return undefined;
  return { text, visibility, slug };
}

function parseWikiQueryArgs(args: string[]): { query: string; limit?: number } | undefined {
  let limit: number | undefined;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit") {
      const value = Number.parseInt(args[index + 1] ?? "", 10);
      index += 1;
      if (!Number.isInteger(value) || value < 1 || value > 20) return undefined;
      limit = value;
      continue;
    }
    rest.push(arg);
  }
  const query = rest.join(" ").trim();
  if (!query) return undefined;
  return { query, limit };
}

function parseWikiWithArgs(args: string[]): { query: string; message: string; limit?: number } | undefined {
  const separator = args.indexOf("--");
  if (separator <= 0 || separator === args.length - 1) return undefined;
  const query = parseWikiQueryArgs(args.slice(0, separator));
  const message = args.slice(separator + 1).join(" ").trim();
  if (!query || !message) return undefined;
  return { ...query, message };
}

function formatWikiQueryResults(results: readonly WikiCommandQueryResult[]): string {
  if (results.length === 0) return "No wiki results.";
  return results
    .map((result, index) => {
      const refs =
        result.sourceRefs && result.sourceRefs.length > 0
          ? `\n  sources: ${result.sourceRefs.map((ref) => ref.displayPath).join(", ")}`
          : "";
      return `${index + 1}. ${result.title} (${result.pagePath})\n${result.excerpt}${refs}`;
    })
    .join("\n\n");
}

function formatWikiLintResult(result: { findings: readonly WikiCommandLintFinding[]; reportPath?: string }): string {
  const header = result.findings.length === 0 ? "Wiki lint passed." : `Wiki lint found ${result.findings.length} issue(s).`;
  const report = result.reportPath ? `\nReport: ${result.reportPath}` : "";
  const findings = result.findings
    .slice(0, 10)
    .map((finding) => `\n- [${finding.severity}] ${finding.kind} ${finding.pagePath}: ${finding.message}`)
    .join("");
  return `${header}${report}${findings}`;
}

function isValidWikiSlug(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(slug) && !slug.includes("..");
}

function looksLikeCronParts(parts: string[]): boolean {
  if (parts.length !== 5) return false;
  return parts.every((part, index) => {
    if (part === "*") return true;
    const parsed = Number.parseInt(part, 10);
    if (!Number.isInteger(parsed) || String(parsed) !== part) return false;
    if (index === 0) return parsed >= 0 && parsed <= 59;
    if (index === 1) return parsed >= 0 && parsed <= 23;
    if (index === 2) return parsed >= 1 && parsed <= 31;
    if (index === 3) return parsed >= 1 && parsed <= 12;
    return parsed >= 0 && parsed <= 6;
  });
}
