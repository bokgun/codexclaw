import type { CodexRuntimeClient } from "../codex/runtime-client.js";
import { CapabilityError, RoutingError } from "../runtime/errors.js";
import { getRuntimePathConfig } from "../config/env.js";
import { assertThreadRoutable, isThreadNotFoundError, readObservedThreadState } from "../runtime/thread-sync.js";
import type { ThreadLabel, ThreadRecord, UserKey } from "../runtime/types.js";
import type { PointerStore } from "../store/pointer-store.js";

export class ThreadManager {
  private readonly newlyStartedThreadIds = new Set<string>();

  constructor(
    private readonly store: PointerStore,
    private readonly codex: CodexRuntimeClient,
    private readonly options: { workspaceRoot?: string } = {}
  ) {}

  async ensureDefaultThread(userKey: UserKey): Promise<ThreadRecord> {
    const active = this.store.getActiveThread(userKey);
    if (active && active.status !== "missing") return active;

    const existingDefault = this.store.getThread(userKey, "default");
    if (existingDefault?.status === "active") return this.store.setActiveThread(userKey, "default");

    const threadId = await this.startManagedThread();
    return this.store.upsertThread({
      userKey,
      label: "default",
      threadId,
      status: "active",
      isDefault: true,
      makeActive: true
    });
  }

  async createThread(userKey: UserKey, label?: string): Promise<ThreadRecord> {
    const normalized = label ? normalizeLabel(label) : this.nextAutoLabel(userKey);
    if (this.store.getThread(userKey, normalized)) {
      throw new RoutingError(`Thread label '${normalized}' already exists. Use /switch ${normalized} or choose a new label.`, "duplicate_thread");
    }
    const threadId = await this.startManagedThread();
    return this.store.upsertThread({
      userKey,
      label: normalized,
      threadId,
      status: "active",
      isDefault: normalized === "default",
      makeActive: true
    });
  }

  listThreads(userKey: UserKey): ThreadRecord[] {
    return this.store.listThreads(userKey);
  }

  async switchThread(userKey: UserKey, label: ThreadLabel): Promise<ThreadRecord> {
    const normalized = normalizeLabel(label);
    const target = this.store.getThread(userKey, normalized);
    if (!target) throw new RoutingError(`Unknown thread label '${normalized}'`, "thread_not_found");
    if (target.status === "archived") {
      await this.recoverArchivedThread(target);
      await this.resumeThread({ ...target, status: "active" });
      return this.store.setActiveThread(userKey, normalized);
    }
    await this.resumeThread(target);
    return this.store.setActiveThread(userKey, normalized);
  }

  async branchThread(userKey: UserKey, label: ThreadLabel): Promise<ThreadRecord> {
    const normalized = normalizeLabel(label);
    if (this.store.getThread(userKey, normalized)) {
      throw new RoutingError(`Thread label '${normalized}' already exists. Use /switch ${normalized} or choose a new label.`, "duplicate_thread");
    }
    if (!this.codex.canForkThread()) {
      throw new CapabilityError("thread/fork is not enabled because M0 has not verified it for this app-server");
    }
    const source = await this.resolveRoutableThread(userKey);
    const threadId = await this.codex.forkThread(source.threadId);
    return this.store.upsertThread({
      userKey,
      label: normalized,
      threadId,
      status: "active",
      makeActive: true
    });
  }

  async archiveThread(userKey: UserKey, label: ThreadLabel): Promise<ThreadRecord> {
    const normalized = normalizeLabel(label);
    const target = this.store.getThread(userKey, normalized);
    if (!target) throw new RoutingError(`Unknown thread label '${normalized}'`, "thread_not_found");
    if (target.status !== "active") {
      throw new RoutingError(`Thread '${normalized}' is ${target.status}; only active labels can be archived.`, "thread_not_routable");
    }
    if (!this.codex.canArchiveThread()) {
      throw new CapabilityError("thread/archive is not enabled because M0 has not verified it for this app-server");
    }

    let fallback = this.store
      .listThreads(userKey)
      .find((thread) => thread.label !== normalized && thread.status === "active");
    if (target.isActive && !fallback) {
      if (normalized === "default") {
        throw new RoutingError("Cannot archive the only active default thread. Create or switch to another label first.", "thread_not_routable");
      }
      if (this.store.getThread(userKey, "default")) {
        throw new RoutingError("Cannot archive the only active thread while default is unavailable. Create or switch to another active label first.", "thread_not_routable");
      }
      fallback = await this.createThread(userKey, "default");
    }

    await this.resumeThread(target);
    await this.codex.archiveThread(target.threadId);
    const archived = this.store.markThreadStatus(userKey, normalized, "archived");

    if (!target.isActive) return archived;

    if (fallback) {
      this.store.setActiveThread(userKey, fallback.label);
      return archived;
    }

    await this.createThread(userKey, "default");
    return archived;
  }

  async resolveRoutableThread(userKey: UserKey): Promise<ThreadRecord> {
    const existingActive = this.store.getActiveThread(userKey);
    const thread = await this.ensureDefaultThread(userKey);
    if (thread.status !== "active") {
      throw new RoutingError(
        `Thread '${thread.label}' is ${thread.status}; switch to an active label or create /new.`,
        "thread_not_routable"
      );
    }
    if (existingActive?.threadId === thread.threadId) {
      try {
        await this.resumeThread(thread);
      } catch (error) {
        const refreshed = this.store.getThread(thread.userKey, thread.label);
        if (refreshed?.status === "missing") return this.ensureDefaultThread(userKey);
        throw error;
      }
    }
    return thread;
  }

  async resolveTaskThread(userKey: UserKey, label: ThreadLabel): Promise<ThreadRecord> {
    const normalized = normalizeLabel(label);
    const existing = this.store.getThread(userKey, normalized);
    if (existing) {
      if (existing.status !== "active") {
        throw new RoutingError(`Thread '${normalized}' is ${existing.status}; scheduled tasks require an active label.`, "thread_not_routable");
      }
      await this.resumeThread(existing);
      return existing;
    }

    const threadId = await this.startManagedThread();
    return this.store.upsertThread({
      userKey,
      label: normalized,
      threadId,
      status: "active",
      isDefault: normalized === "default",
      makeActive: false
    });
  }

  markRouted(record: ThreadRecord): ThreadRecord {
    return this.store.markRouted(record.userKey, record.label);
  }

  quarantineThread(record: ThreadRecord, _reason: string): ThreadRecord {
    return this.store.markThreadStatus(record.userKey, record.label, "quarantined");
  }

  async resumeThread(record: ThreadRecord): Promise<void> {
    const current = this.store.getThread(record.userKey, record.label) ?? record;
    await assertThreadRoutable(this.store, this.codex, current, this.workspaceRoot());
    if (!current.lastRoutedAt && this.newlyStartedThreadIds.has(current.threadId)) return;
    try {
      await this.codex.resumeThread(current.threadId, true);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        this.store.markThreadStatus(current.userKey, current.label, "missing");
        throw new RoutingError(`Thread '${current.label}' is missing; create /thread new instead.`, "thread_not_routable");
      }
      throw error;
    }
  }

  async tryResumeThread(record: ThreadRecord): Promise<boolean> {
    try {
      await this.resumeThread(record);
      return true;
    } catch {
      return false;
    }
  }

  private async recoverArchivedThread(record: ThreadRecord): Promise<void> {
    const observed = await readObservedThreadState(this.codex, record.threadId, this.workspaceRoot(), {
      verifyListMembership: true
    });
    if (observed.state === "missing") {
      this.store.markThreadStatus(record.userKey, record.label, "missing");
      throw new RoutingError(`Thread '${record.label}' is missing; create /thread new instead.`, "thread_not_routable");
    }
    if (observed.state === "active") {
      this.store.markThreadStatus(record.userKey, record.label, "active");
      return;
    }
    if (observed.reason === "cwd_mismatch") {
      this.store.markThreadStatus(record.userKey, record.label, "quarantined");
      throw new RoutingError(`Thread '${record.label}' belongs to another workspace; create /thread new instead.`, "thread_not_routable");
    }
    if (observed.state === "unknown") {
      throw new RoutingError(`Thread '${record.label}' could not be verified; create /thread new instead.`, "thread_not_routable");
    }
    if (!this.codex.canUnarchiveThread()) {
      throw new CapabilityError("thread/unarchive is not enabled because M4b has not verified it for this app-server");
    }
    await this.codex.unarchiveThread(record.threadId);
    this.store.markThreadStatus(record.userKey, record.label, "active");
  }

  private workspaceRoot(): string {
    return this.options.workspaceRoot ?? getRuntimePathConfig().workspaceRoot;
  }

  private async startManagedThread(): Promise<string> {
    const threadId = await this.codex.startThread({});
    this.newlyStartedThreadIds.add(threadId);
    return threadId;
  }

  private nextAutoLabel(userKey: UserKey): string {
    const existing = new Set(this.store.listThreads(userKey).map((thread) => thread.label));
    for (let index = 1; index < 10_000; index += 1) {
      const label = `thread-${index}`;
      if (!existing.has(label)) return label;
    }
    throw new RoutingError("Unable to allocate a new thread label.", "label_exhausted");
  }
}

export function normalizeLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return "default";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new RoutingError("Labels must use letters, numbers, '.', '_' or '-' and be 64 chars or less.", "invalid_label");
  }
  return normalized;
}
