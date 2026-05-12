import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import type {
  ChannelName,
  PendingApprovalRecord,
  PrefKey,
  PrefRecord,
  TaskDedupePolicy,
  TaskRecord,
  TaskRunStatus,
  ThreadId,
  ThreadLabel,
  ThreadRecord,
  ThreadRouteStatus,
  TimestampIso,
  UserKey
} from "../runtime/types.js";

const SCHEMA_VERSION = 7;

interface ThreadRow {
  user_key: string;
  label: string;
  thread_id: string;
  status: ThreadRouteStatus;
  is_default: number;
  is_active: number;
  last_routed_at: string | null;
  suppress_branch_until: string | null;
  last_branch_suggested_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PendingApprovalRow {
  channel_msg_id: string;
  user_key: string;
  thread_id: string;
  jsonrpc_id: string;
  jsonrpc_id_type: "number" | "string";
  host_instance_id: string | null;
  approval_kind: string;
  channel: ChannelName;
  expires_at: string;
  created_at: string;
}

interface TaskRow {
  task_id: string;
  user_key: string;
  thread_label: string;
  channel: ChannelName;
  schedule: string;
  task_instruction: string;
  enabled: number;
  retry: number;
  timeout_sec: number;
  dedupe_policy: TaskDedupePolicy;
  last_run_at: string | null;
  last_run_status: TaskRunStatus | null;
  consecutive_failures: number;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

interface PrefRow {
  user_key: string;
  pref_key: PrefKey;
  pref_value: string;
  updated_at: string;
}

interface PluginEnablementRow {
  plugin_id: string;
  version: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface StoreCountRow {
  count: number;
}

export interface UpsertThreadInput {
  userKey: UserKey;
  label: ThreadLabel;
  threadId: ThreadId;
  status?: ThreadRouteStatus;
  isDefault?: boolean;
  makeActive?: boolean;
  lastRoutedAt?: TimestampIso;
  suppressBranchUntil?: TimestampIso;
  lastBranchSuggestedAt?: TimestampIso;
}

export interface SavePendingApprovalInput {
  channelMsgId: string;
  userKey: UserKey;
  threadId: ThreadId;
  jsonrpcId: string;
  jsonrpcIdType?: "number" | "string";
  hostInstanceId?: string;
  approvalKind: string;
  channel: ChannelName;
  expiresAt: TimestampIso;
}

export type PendingApprovalValidation =
  | { kind: "valid"; record: PendingApprovalRecord }
  | { kind: "expired"; record: PendingApprovalRecord }
  | { kind: "mismatch"; reason: "user" | "channel" | "thread" | "host"; record: PendingApprovalRecord }
  | { kind: "missing" };

export type PendingApprovalClaim =
  | { kind: "claimed"; record: PendingApprovalRecord }
  | { kind: "expired"; record: PendingApprovalRecord }
  | { kind: "mismatch"; reason: "user" | "channel" | "thread" | "host"; record: PendingApprovalRecord }
  | { kind: "missing" };

export interface PendingApprovalRecoveryInput {
  channelMsgId: string;
  userKey: UserKey;
  channel: ChannelName;
  now?: TimestampIso;
  threadId?: ThreadId;
  hostInstanceId?: string;
}

export interface CreateTaskInput {
  taskId?: string;
  userKey: UserKey;
  label: ThreadLabel;
  channel: ChannelName;
  schedule: string;
  taskText: string;
  retry?: number;
  timeoutSec?: number;
  dedupePolicy?: TaskDedupePolicy;
  nextRunAt: TimestampIso;
}

export interface PluginEnablementState {
  pluginId: string;
  version?: string;
  enabled: boolean;
  createdAt: TimestampIso;
  updatedAt: TimestampIso;
}

export interface SetPluginEnablementInput {
  pluginId: string;
  version?: string;
  enabled: boolean;
}

export class PointerStore {
  readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  upsertThread(input: UpsertThreadInput): ThreadRecord {
    const now = new Date().toISOString();
    const status = input.status ?? "active";

    return this.transaction(() => {
      if (input.makeActive) this.clearActive(input.userKey);

      this.db
        .query(
          `insert into threads (
            user_key, label, thread_id, status, is_default, is_active,
            last_routed_at, suppress_branch_until, last_branch_suggested_at, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(user_key, label) do update set
            thread_id = excluded.thread_id,
            status = excluded.status,
            is_default = max(threads.is_default, excluded.is_default),
            is_active = case when excluded.is_active = 1 then 1 else threads.is_active end,
            last_routed_at = coalesce(excluded.last_routed_at, threads.last_routed_at),
            suppress_branch_until = coalesce(excluded.suppress_branch_until, threads.suppress_branch_until),
            last_branch_suggested_at = coalesce(excluded.last_branch_suggested_at, threads.last_branch_suggested_at),
            updated_at = excluded.updated_at`
        )
        .run(
          input.userKey,
          input.label,
          input.threadId,
          status,
          input.isDefault ? 1 : 0,
          input.makeActive ? 1 : 0,
          input.lastRoutedAt ?? null,
          input.suppressBranchUntil ?? null,
          input.lastBranchSuggestedAt ?? null,
          now,
          now
        );

      return this.requireThread(input.userKey, input.label);
    });
  }

  listThreads(userKey: UserKey): ThreadRecord[] {
    const rows = this.db
      .query<ThreadRow, [string]>(
        `select * from threads where user_key = ? order by is_active desc, is_default desc, label asc`
      )
      .all(userKey);
    return rows.map(threadFromRow);
  }

  listAllThreads(): ThreadRecord[] {
    const rows = this.db
      .query<ThreadRow, []>(`select * from threads order by user_key asc, is_active desc, label asc`)
      .all();
    return rows.map(threadFromRow);
  }

  getThread(userKey: UserKey, label: ThreadLabel): ThreadRecord | undefined {
    const row = this.db
      .query<ThreadRow, [string, string]>(`select * from threads where user_key = ? and label = ?`)
      .get(userKey, label);
    return row ? threadFromRow(row) : undefined;
  }

  getActiveThread(userKey: UserKey): ThreadRecord | undefined {
    const row = this.db
      .query<ThreadRow, [string]>(`select * from threads where user_key = ? and is_active = 1`)
      .get(userKey);
    return row ? threadFromRow(row) : undefined;
  }

  setActiveThread(userKey: UserKey, label: ThreadLabel): ThreadRecord {
    return this.transaction(() => {
      const existing = this.requireThread(userKey, label);
      if (existing.status !== "active") {
        throw new Error(`Cannot route to ${existing.status} thread '${label}'`);
      }

      this.clearActive(userKey);
      this.db
        .query(`update threads set is_active = 1, updated_at = ? where user_key = ? and label = ?`)
        .run(new Date().toISOString(), userKey, label);
      return this.requireThread(userKey, label);
    });
  }

  markThreadStatus(userKey: UserKey, label: ThreadLabel, status: ThreadRouteStatus): ThreadRecord {
    this.db
      .query(`update threads set status = ?, updated_at = ? where user_key = ? and label = ?`)
      .run(status, new Date().toISOString(), userKey, label);
    return this.requireThread(userKey, label);
  }

  markRouted(userKey: UserKey, label: ThreadLabel, routedAt = new Date().toISOString()): ThreadRecord {
    this.db
      .query(`update threads set last_routed_at = ?, updated_at = ? where user_key = ? and label = ?`)
      .run(routedAt, new Date().toISOString(), userKey, label);
    return this.requireThread(userKey, label);
  }

  setSuppressBranchUntil(userKey: UserKey, label: ThreadLabel, suppressUntil: TimestampIso): ThreadRecord {
    this.db
      .query(`update threads set suppress_branch_until = ?, updated_at = ? where user_key = ? and label = ?`)
      .run(suppressUntil, new Date().toISOString(), userKey, label);
    return this.requireThread(userKey, label);
  }

  markBranchSuggested(userKey: UserKey, label: ThreadLabel, suggestedAt = new Date().toISOString()): ThreadRecord {
    this.db
      .query(`update threads set last_branch_suggested_at = ?, updated_at = ? where user_key = ? and label = ?`)
      .run(suggestedAt, new Date().toISOString(), userKey, label);
    return this.requireThread(userKey, label);
  }

  getLastBranchSuggestedAt(userKey: UserKey): TimestampIso | undefined {
    const row = this.db
      .query<{ last_branch_suggested_at: string | null }, [string]>(
        `select max(last_branch_suggested_at) as last_branch_suggested_at
         from threads
         where user_key = ?`
      )
      .get(userKey);
    return row?.last_branch_suggested_at ?? undefined;
  }

  savePendingApproval(input: SavePendingApprovalInput): PendingApprovalRecord {
    const createdAt = new Date().toISOString();
    this.db
      .query(
        `insert into pending_approvals (
          channel_msg_id, user_key, thread_id, jsonrpc_id, jsonrpc_id_type, host_instance_id, approval_kind, channel, expires_at, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(channel_msg_id) do update set
          user_key = excluded.user_key,
          thread_id = excluded.thread_id,
          jsonrpc_id = excluded.jsonrpc_id,
          jsonrpc_id_type = excluded.jsonrpc_id_type,
          host_instance_id = excluded.host_instance_id,
          approval_kind = excluded.approval_kind,
          channel = excluded.channel,
          expires_at = excluded.expires_at`
      )
      .run(
        input.channelMsgId,
        input.userKey,
        input.threadId,
        input.jsonrpcId,
        input.jsonrpcIdType ?? "string",
        input.hostInstanceId ?? null,
        input.approvalKind,
        input.channel,
        input.expiresAt,
        createdAt
      );

    return this.requirePendingApproval(input.channelMsgId);
  }

  getPendingApproval(channelMsgId: string): PendingApprovalRecord | undefined {
    const row = this.db
      .query<PendingApprovalRow, [string]>(`select * from pending_approvals where channel_msg_id = ?`)
      .get(channelMsgId);
    return row ? pendingApprovalFromRow(row) : undefined;
  }

  validatePendingApproval(input: PendingApprovalRecoveryInput): PendingApprovalValidation {
    const record = this.getPendingApproval(input.channelMsgId);
    if (!record) return { kind: "missing" };
    const mismatch = pendingApprovalMismatch(record, input);
    if (mismatch) return { kind: "mismatch", reason: mismatch, record };
    if (record.expiresAt <= (input.now ?? new Date().toISOString())) return { kind: "expired", record };
    return { kind: "valid", record };
  }

  claimPendingApproval(input: PendingApprovalRecoveryInput): PendingApprovalClaim {
    return this.transaction(() => {
      const record = this.getPendingApproval(input.channelMsgId);
      if (!record) return { kind: "missing" };
      const mismatch = pendingApprovalMismatch(record, input);
      if (mismatch) return { kind: "mismatch", reason: mismatch, record };

      const deleted = this.deletePendingApproval(input.channelMsgId);
      if (!deleted) return { kind: "missing" };
      if (record.expiresAt <= (input.now ?? new Date().toISOString())) return { kind: "expired", record };
      return { kind: "claimed", record };
    });
  }

  deletePendingApproval(channelMsgId: string): boolean {
    const result = this.db.query(`delete from pending_approvals where channel_msg_id = ?`).run(channelMsgId);
    return result.changes > 0;
  }

  expirePendingApprovals(now = new Date().toISOString()): PendingApprovalRecord[] {
    const rows = this.db
      .query<PendingApprovalRow, [string]>(`select * from pending_approvals where expires_at <= ?`)
      .all(now);
    this.db.query(`delete from pending_approvals where expires_at <= ?`).run(now);
    return rows.map(pendingApprovalFromRow);
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const now = new Date().toISOString();
    const taskId = input.taskId ?? `task-${crypto.randomUUID()}`;
    this.db
      .query(
        `insert into tasks (
          task_id, user_key, thread_label, channel, schedule, task_instruction, enabled,
          retry, timeout_sec, dedupe_policy, consecutive_failures, next_run_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        taskId,
        input.userKey,
        input.label,
        input.channel,
        input.schedule,
        input.taskText,
        input.retry ?? 0,
        input.timeoutSec ?? 300,
        input.dedupePolicy ?? "concurrency_1",
        input.nextRunAt,
        now,
        now
      );
    return this.requireTask(taskId);
  }

  listTasks(userKey: UserKey): TaskRecord[] {
    return this.db
      .query<TaskRow, [string]>(`select * from tasks where user_key = ? order by created_at asc`)
      .all(userKey)
      .map(taskFromRow);
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db.query<TaskRow, [string]>(`select * from tasks where task_id = ?`).get(taskId);
    return row ? taskFromRow(row) : undefined;
  }

  listDueTasks(channel: ChannelName, now = new Date().toISOString()): TaskRecord[] {
    return this.db
      .query<TaskRow, [string, string]>(
        `select * from tasks where enabled = 1 and channel = ? and next_run_at <= ? order by next_run_at asc, created_at asc`
      )
      .all(channel, now)
      .map(taskFromRow);
  }

  setTaskEnabled(taskId: string, enabled: boolean): TaskRecord {
    this.db
      .query(`update tasks set enabled = ?, updated_at = ? where task_id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), taskId);
    return this.requireTask(taskId);
  }

  deleteTask(taskId: string): boolean {
    return this.db.query(`delete from tasks where task_id = ?`).run(taskId).changes > 0;
  }

  markTaskRunStart(taskId: string, nextRunAt: TimestampIso, runAt = new Date().toISOString()): TaskRecord {
    this.db
      .query(`update tasks set last_run_at = ?, next_run_at = ?, updated_at = ? where task_id = ?`)
      .run(runAt, nextRunAt, new Date().toISOString(), taskId);
    return this.requireTask(taskId);
  }

  markTaskRunSuccess(taskId: string, nextRunAt: TimestampIso, runAt = new Date().toISOString()): TaskRecord {
    this.db
      .query(
        `update tasks
         set last_run_at = ?, last_run_status = 'succeeded', consecutive_failures = 0,
             next_run_at = ?, updated_at = ?
         where task_id = ?`
      )
      .run(runAt, nextRunAt, new Date().toISOString(), taskId);
    return this.requireTask(taskId);
  }

  markTaskRunFailure(
    taskId: string,
    status: Exclude<TaskRunStatus, "succeeded" | "skipped_dedupe" | "skipped_channel">,
    nextRunAt: TimestampIso,
    failureThreshold: number,
    runAt = new Date().toISOString()
  ): TaskRecord {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      const failures = task.consecutiveFailures + 1;
      this.db
        .query(
          `update tasks
           set last_run_at = ?, last_run_status = ?, consecutive_failures = ?,
               enabled = case when ? >= ? then 0 else enabled end,
               next_run_at = ?, updated_at = ?
           where task_id = ?`
        )
        .run(runAt, status, failures, failures, failureThreshold, nextRunAt, new Date().toISOString(), taskId);
      return this.requireTask(taskId);
    });
  }

  markTaskSkipped(taskId: string, status: "skipped_dedupe" | "skipped_channel", nextRunAt: TimestampIso): TaskRecord {
    this.db
      .query(`update tasks set last_run_status = ?, next_run_at = ?, updated_at = ? where task_id = ?`)
      .run(status, nextRunAt, new Date().toISOString(), taskId);
    return this.requireTask(taskId);
  }

  listPrefs(userKey: UserKey): PrefRecord[] {
    return this.db
      .query<PrefRow, [string]>(`select * from prefs where user_key = ? order by pref_key asc`)
      .all(userKey)
      .map(prefFromRow);
  }

  setPref(userKey: UserKey, key: PrefKey, value: string): PrefRecord {
    const normalized = normalizePrefValue(value);
    if (!normalized) throw new Error("Preference value must not be empty.");
    const now = new Date().toISOString();
    this.db
      .query(
        `insert into prefs (user_key, pref_key, pref_value, updated_at) values (?, ?, ?, ?)
         on conflict(user_key, pref_key) do update set
           pref_value = excluded.pref_value,
           updated_at = excluded.updated_at`
      )
      .run(userKey, key, normalized, now);
    return this.requirePref(userKey, key);
  }

  unsetPref(userKey: UserKey, key: PrefKey): boolean {
    return this.db.query(`delete from prefs where user_key = ? and pref_key = ?`).run(userKey, key).changes > 0;
  }

  setPluginEnablement(input: SetPluginEnablementInput): PluginEnablementState {
    const pluginId = normalizePluginIdentity(input.pluginId, "plugin id");
    const version = input.version ? normalizePluginIdentity(input.version, "plugin version") : undefined;
    const now = new Date().toISOString();
    this.db
      .query(
        `insert into plugin_enablement (plugin_id, version, enabled, created_at, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(plugin_id) do update set
           version = excluded.version,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`
      )
      .run(pluginId, version ?? null, input.enabled ? 1 : 0, now, now);
    return this.requirePluginEnablement(pluginId);
  }

  getPluginEnablement(pluginId: string): PluginEnablementState | undefined {
    const row = this.db
      .query<PluginEnablementRow, [string]>(`select * from plugin_enablement where plugin_id = ?`)
      .get(pluginId);
    return row ? pluginEnablementFromRow(row) : undefined;
  }

  listPluginEnablement(): PluginEnablementState[] {
    return this.db
      .query<PluginEnablementRow, []>(`select * from plugin_enablement order by plugin_id asc`)
      .all()
      .map(pluginEnablementFromRow);
  }

  schemaColumns(tableName: "threads" | "pending_approvals" | "tasks" | "prefs" | "plugin_enablement"): string[] {
    return this.db
      .query<{ name: string }, []>(`pragma table_info(${tableName})`)
      .all()
      .map((row) => row.name);
  }

  private migrate(): void {
    this.db.exec("pragma foreign_keys = on");
    this.db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        applied_at text not null
      )
    `);

    const currentVersion =
      this.db.query<{ version: number | null }, []>(`select max(version) as version from schema_migrations`).get()
        ?.version ?? 0;
    if (currentVersion >= SCHEMA_VERSION) return;

    this.transaction(() => {
      this.db.exec(`
        create table if not exists threads (
          user_key text not null,
          label text not null,
          thread_id text not null,
          status text not null default 'active' check(status in ('active', 'archived', 'missing', 'quarantined')),
          is_default integer not null default 0 check(is_default in (0, 1)),
          is_active integer not null default 0 check(is_active in (0, 1)),
          last_routed_at text,
          suppress_branch_until text,
          last_branch_suggested_at text,
          created_at text not null,
          updated_at text not null,
          primary key (user_key, label)
        );
        create unique index if not exists threads_one_default_per_user
          on threads(user_key) where is_default = 1;
        create unique index if not exists threads_one_active_per_user
          on threads(user_key) where is_active = 1;
        create index if not exists threads_thread_id_idx on threads(thread_id);

        create table if not exists pending_approvals (
          channel_msg_id text primary key,
          user_key text not null,
          thread_id text not null,
          jsonrpc_id text not null,
          jsonrpc_id_type text not null default 'string' check(jsonrpc_id_type in ('number', 'string')),
          host_instance_id text,
          approval_kind text not null,
          channel text not null,
          expires_at text not null,
          created_at text not null
        );
        drop index if exists pending_approvals_jsonrpc_id_idx;
        create index if not exists pending_approvals_expiry_idx
          on pending_approvals(expires_at);

        create table if not exists tasks (
          task_id text primary key,
          user_key text not null,
          thread_label text not null,
          channel text not null default 'cli' check(channel in ('cli', 'telegram', 'discord')),
          schedule text not null,
          task_instruction text not null default '',
          enabled integer not null default 1 check(enabled in (0, 1)),
          retry integer not null default 0 check(retry >= 0 and retry <= 10),
          timeout_sec integer not null default 300 check(timeout_sec >= 1 and timeout_sec <= 86400),
          dedupe_policy text not null default 'concurrency_1' check(dedupe_policy in ('concurrency_1')),
          last_run_at text,
          last_run_status text check(last_run_status in ('succeeded', 'failed', 'skipped_dedupe', 'timed_out', 'skipped_channel')),
          consecutive_failures integer not null default 0 check(consecutive_failures >= 0),
          next_run_at text not null default '1970-01-01T00:00:00.000Z',
          created_at text not null,
          updated_at text not null
        );

        create table if not exists prefs (
          user_key text not null,
          pref_key text not null,
          pref_value text not null,
          updated_at text not null,
          primary key (user_key, pref_key)
        );

        create table if not exists plugin_enablement (
          plugin_id text primary key,
          version text,
          enabled integer not null default 0 check(enabled in (0, 1)),
          created_at text not null,
          updated_at text not null
        );
      `);

      const threadColumns = this.schemaColumns("threads");
      if (!threadColumns.includes("last_branch_suggested_at")) {
        this.db.exec(`alter table threads add column last_branch_suggested_at text`);
      }

      const pendingApprovalColumns = this.schemaColumns("pending_approvals");
      if (!pendingApprovalColumns.includes("channel")) {
        this.db.exec(`alter table pending_approvals add column channel text not null default 'cli'`);
      }
      if (!pendingApprovalColumns.includes("jsonrpc_id_type")) {
        this.db.exec(`alter table pending_approvals add column jsonrpc_id_type text not null default 'string' check(jsonrpc_id_type in ('number', 'string'))`);
      }
      if (!pendingApprovalColumns.includes("host_instance_id")) {
        this.db.exec(`alter table pending_approvals add column host_instance_id text`);
      }

      const taskColumns = this.schemaColumns("tasks");
      const addTaskColumn = (name: string, definition: string): void => {
        if (!taskColumns.includes(name)) this.db.exec(`alter table tasks add column ${definition}`);
      };
      addTaskColumn("channel", `channel text not null default 'cli' check(channel in ('cli', 'telegram', 'discord'))`);
      addTaskColumn("task_instruction", `task_instruction text not null default ''`);
      addTaskColumn("retry", `retry integer not null default 0 check(retry >= 0 and retry <= 10)`);
      addTaskColumn("timeout_sec", `timeout_sec integer not null default 300 check(timeout_sec >= 1 and timeout_sec <= 86400)`);
      addTaskColumn("dedupe_policy", `dedupe_policy text not null default 'concurrency_1' check(dedupe_policy in ('concurrency_1'))`);
      addTaskColumn("last_run_at", `last_run_at text`);
      addTaskColumn("last_run_status", `last_run_status text check(last_run_status in ('succeeded', 'failed', 'skipped_dedupe', 'timed_out', 'skipped_channel'))`);
      addTaskColumn("consecutive_failures", `consecutive_failures integer not null default 0 check(consecutive_failures >= 0)`);
      addTaskColumn("next_run_at", `next_run_at text not null default '1970-01-01T00:00:00.000Z'`);
      this.db.exec(`create index if not exists tasks_due_idx on tasks(channel, enabled, next_run_at)`);

      this.db
        .query(`insert into schema_migrations (version, applied_at) values (?, ?)`)
        .run(SCHEMA_VERSION, new Date().toISOString());
    });
  }

  private requireThread(userKey: UserKey, label: ThreadLabel): ThreadRecord {
    const thread = this.getThread(userKey, label);
    if (!thread) throw new Error(`Unknown thread label '${label}' for ${userKey}`);
    return thread;
  }

  private requirePendingApproval(channelMsgId: string): PendingApprovalRecord {
    const approval = this.getPendingApproval(channelMsgId);
    if (!approval) throw new Error(`Unknown pending approval '${channelMsgId}'`);
    return approval;
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Unknown task '${taskId}'`);
    return task;
  }

  private requirePref(userKey: UserKey, key: PrefKey): PrefRecord {
    const pref = this.listPrefs(userKey).find((record) => record.key === key);
    if (!pref) throw new Error(`Unknown preference '${key}' for ${userKey}`);
    return pref;
  }

  private requirePluginEnablement(pluginId: string): PluginEnablementState {
    const state = this.getPluginEnablement(pluginId);
    if (!state) throw new Error(`Unknown plugin enablement '${pluginId}'`);
    return state;
  }

  private clearActive(userKey: UserKey): void {
    this.db.query(`update threads set is_active = 0, updated_at = ? where user_key = ?`).run(
      new Date().toISOString(),
      userKey
    );
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec("begin immediate");
    try {
      const value = callback();
      this.db.exec("commit");
      return value;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
}

export function createPointerStore(path?: string): PointerStore {
  return new PointerStore(path);
}

function threadFromRow(row: ThreadRow): ThreadRecord {
  return {
    userKey: row.user_key,
    label: row.label,
    threadId: row.thread_id,
    status: row.status,
    isDefault: row.is_default === 1,
    isActive: row.is_active === 1,
    lastRoutedAt: row.last_routed_at ?? undefined,
    suppressBranchUntil: row.suppress_branch_until ?? undefined,
    lastBranchSuggestedAt: row.last_branch_suggested_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function pendingApprovalFromRow(row: PendingApprovalRow): PendingApprovalRecord {
  return {
    channelMsgId: row.channel_msg_id,
    userKey: row.user_key,
    threadId: row.thread_id,
    jsonrpcId: row.jsonrpc_id,
    jsonrpcIdType: row.jsonrpc_id_type,
    hostInstanceId: row.host_instance_id ?? undefined,
    approvalKind: row.approval_kind,
    channel: row.channel,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

function pendingApprovalMismatch(
  record: PendingApprovalRecord,
  input: PendingApprovalRecoveryInput
): "user" | "channel" | "thread" | "host" | undefined {
  if (record.userKey !== input.userKey) return "user";
  if (record.channel !== input.channel) return "channel";
  if (input.threadId && record.threadId !== input.threadId) return "thread";
  if (input.hostInstanceId && record.hostInstanceId !== input.hostInstanceId) return "host";
  return undefined;
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    userKey: row.user_key,
    label: row.thread_label,
    channel: row.channel,
    schedule: row.schedule,
    taskText: row.task_instruction,
    enabled: row.enabled === 1,
    retry: row.retry,
    timeoutSec: row.timeout_sec,
    dedupePolicy: row.dedupe_policy,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunStatus: row.last_run_status ?? undefined,
    consecutiveFailures: row.consecutive_failures,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function prefFromRow(row: PrefRow): PrefRecord {
  return {
    userKey: row.user_key,
    key: row.pref_key,
    value: row.pref_value,
    updatedAt: row.updated_at
  };
}

function pluginEnablementFromRow(row: PluginEnablementRow): PluginEnablementState {
  return {
    pluginId: row.plugin_id,
    version: row.version ?? undefined,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizePrefValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
}

function normalizePluginIdentity(value: string, label: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
  if (!normalized) throw new Error(`Plugin ${label} must not be empty.`);
  return normalized;
}

export function countActiveThreads(store: PointerStore, userKey: UserKey): number {
  return (
    store.db
      .query<StoreCountRow, [string]>(`select count(*) as count from threads where user_key = ? and is_active = 1`)
      .get(userKey)?.count ?? 0
  );
}
