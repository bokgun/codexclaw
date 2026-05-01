import { Database } from "bun:sqlite";
import type {
  ChannelName,
  PendingApprovalRecord,
  ThreadId,
  ThreadLabel,
  ThreadRecord,
  ThreadRouteStatus,
  TimestampIso,
  UserKey
} from "../runtime/types.js";

const SCHEMA_VERSION = 3;

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
  approval_kind: string;
  channel: ChannelName;
  expires_at: string;
  created_at: string;
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
  approvalKind: string;
  channel: ChannelName;
  expiresAt: TimestampIso;
}

export class PointerStore {
  readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true, strict: true });
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
          channel_msg_id, user_key, thread_id, jsonrpc_id, approval_kind, channel, expires_at, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(channel_msg_id) do update set
          user_key = excluded.user_key,
          thread_id = excluded.thread_id,
          jsonrpc_id = excluded.jsonrpc_id,
          approval_kind = excluded.approval_kind,
          channel = excluded.channel,
          expires_at = excluded.expires_at`
      )
      .run(
        input.channelMsgId,
        input.userKey,
        input.threadId,
        input.jsonrpcId,
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

  schemaColumns(tableName: "threads" | "pending_approvals" | "tasks" | "prefs"): string[] {
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
          schedule text not null,
          enabled integer not null default 1 check(enabled in (0, 1)),
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
      `);

      const threadColumns = this.schemaColumns("threads");
      if (!threadColumns.includes("last_branch_suggested_at")) {
        this.db.exec(`alter table threads add column last_branch_suggested_at text`);
      }

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
    approvalKind: row.approval_kind,
    channel: row.channel,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

export function countActiveThreads(store: PointerStore, userKey: UserKey): number {
  return (
    store.db
      .query<StoreCountRow, [string]>(`select count(*) as count from threads where user_key = ? and is_active = 1`)
      .get(userKey)?.count ?? 0
  );
}
