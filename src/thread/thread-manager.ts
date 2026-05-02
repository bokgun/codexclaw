import type { CodexRuntimeClient } from "../codex/runtime-client.js";
import { CapabilityError, RoutingError } from "../runtime/errors.js";
import type { ThreadLabel, ThreadRecord, UserKey } from "../runtime/types.js";
import type { PointerStore } from "../store/pointer-store.js";

export class ThreadManager {
  constructor(
    private readonly store: PointerStore,
    private readonly codex: CodexRuntimeClient
  ) {}

  async ensureDefaultThread(userKey: UserKey): Promise<ThreadRecord> {
    const active = this.store.getActiveThread(userKey);
    if (active) return active;

    const existingDefault = this.store.getThread(userKey, "default");
    if (existingDefault?.status === "active") return this.store.setActiveThread(userKey, "default");

    const threadId = await this.codex.startThread({});
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
    const threadId = await this.codex.startThread({});
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

    const fallback = this.store
      .listThreads(userKey)
      .find((thread) => thread.label !== normalized && thread.status === "active");
    if (target.isActive && !fallback && normalized === "default") {
      throw new RoutingError("Cannot archive the only active default thread. Create or switch to another label first.", "thread_not_routable");
    }

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
    const thread = await this.ensureDefaultThread(userKey);
    if (thread.status !== "active") {
      throw new RoutingError(
        `Thread '${thread.label}' is ${thread.status}; switch to an active label or create /new.`,
        "thread_not_routable"
      );
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

    const threadId = await this.codex.startThread({});
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

  async resumeThread(record: ThreadRecord): Promise<void> {
    await this.codex.readThread(record.threadId, false);
    await this.codex.resumeThread(record.threadId, true);
  }

  async tryResumeThread(record: ThreadRecord): Promise<boolean> {
    try {
      await this.resumeThread(record);
      return true;
    } catch {
      this.store.markThreadStatus(record.userKey, record.label, "missing");
      return false;
    }
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
