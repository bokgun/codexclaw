import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PointerStore, countActiveThreads } from "../../src/store/pointer-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PointerStore", () => {
  test("creates sqlite files with private permissions", () => {
    const dbPath = tempDbPath();
    const store = new PointerStore(dbPath);
    store.close();

    expect(statSync(dbPath).mode & 0o077).toBe(0);
  });

  test("migrates pointer tables and CRUDs thread pointers", () => {
    const store = newStore();
    const routedAt = "2026-05-01T00:00:00.000Z";

    const created = store.upsertThread({
      userKey: "user:1",
      label: "default",
      threadId: "thread-default",
      isDefault: true,
      makeActive: true,
      lastRoutedAt: routedAt
    });

    expect(created).toMatchObject({
      userKey: "user:1",
      label: "default",
      threadId: "thread-default",
      status: "active",
      isDefault: true,
      isActive: true,
      lastRoutedAt: routedAt
    });
    expect(store.getThread("user:1", "default")?.threadId).toBe("thread-default");
    expect(store.getActiveThread("user:1")?.label).toBe("default");

    const touched = store.markRouted("user:1", "default", "2026-05-01T01:00:00.000Z");
    expect(touched.lastRoutedAt).toBe("2026-05-01T01:00:00.000Z");

    const archived = store.markThreadStatus("user:1", "default", "archived");
    expect(archived.status).toBe("archived");
  });

  test("keeps exactly one active label across new switch and branch-like writes", () => {
    const store = newStore();

    store.upsertThread({
      userKey: "user:active",
      label: "default",
      threadId: "thread-default",
      isDefault: true,
      makeActive: true
    });
    expect(activeLabels(store, "user:active")).toEqual(["default"]);

    store.upsertThread({
      userKey: "user:active",
      label: "ops",
      threadId: "thread-ops",
      makeActive: true
    });
    expect(activeLabels(store, "user:active")).toEqual(["ops"]);

    store.setActiveThread("user:active", "default");
    expect(activeLabels(store, "user:active")).toEqual(["default"]);

    store.upsertThread({
      userKey: "user:active",
      label: "branch-1",
      threadId: "thread-branch",
      makeActive: true
    });
    expect(activeLabels(store, "user:active")).toEqual(["branch-1"]);
    expect(countActiveThreads(store, "user:active")).toBe(1);
  });

  test("stores and expires pending approval mappings", () => {
    const store = newStore();

    const approval = store.savePendingApproval({
      channelMsgId: "channel-msg-1",
      userKey: "user:approval",
      threadId: "thread-approval",
      jsonrpcId: "rpc-1",
      approvalKind: "command",
      channel: "cli",
      expiresAt: "2026-05-01T01:00:00.000Z"
    });

    expect(approval).toMatchObject({
      channelMsgId: "channel-msg-1",
      userKey: "user:approval",
      threadId: "thread-approval",
      jsonrpcId: "rpc-1",
      approvalKind: "command",
      channel: "cli",
      expiresAt: "2026-05-01T01:00:00.000Z"
    });
    expect(store.getPendingApproval("channel-msg-1")?.jsonrpcId).toBe("rpc-1");
    expect(store.expirePendingApprovals("2026-05-01T00:59:59.000Z")).toHaveLength(0);
    expect(store.expirePendingApprovals("2026-05-01T01:00:00.000Z")).toHaveLength(1);
    expect(store.getPendingApproval("channel-msg-1")).toBeUndefined();
  });

  test("allows reused jsonrpc ids across different approval prompts", () => {
    const store = newStore();

    store.savePendingApproval({
      channelMsgId: "channel-msg-a",
      userKey: "user:approval",
      threadId: "thread-approval",
      jsonrpcId: "rpc-1",
      approvalKind: "command",
      channel: "cli",
      expiresAt: "2026-05-01T01:00:00.000Z"
    });
    store.savePendingApproval({
      channelMsgId: "channel-msg-b",
      userKey: "user:approval",
      threadId: "thread-approval",
      jsonrpcId: "rpc-1",
      approvalKind: "command",
      channel: "cli",
      expiresAt: "2026-05-01T01:00:00.000Z"
    });

    expect(store.getPendingApproval("channel-msg-a")).toBeDefined();
    expect(store.getPendingApproval("channel-msg-b")).toBeDefined();
  });

  test("preserves pending approval json-rpc id type", () => {
    const store = newStore();

    store.savePendingApproval({
      channelMsgId: "channel-msg-number",
      userKey: "user:approval",
      threadId: "thread-approval",
      jsonrpcId: "42",
      jsonrpcIdType: "number",
      hostInstanceId: "host-number",
      approvalKind: "command",
      channel: "telegram",
      expiresAt: "2026-05-01T01:00:00.000Z"
    });
    store.savePendingApproval({
      channelMsgId: "channel-msg-string",
      userKey: "user:approval",
      threadId: "thread-approval",
      jsonrpcId: "42",
      jsonrpcIdType: "string",
      approvalKind: "command",
      channel: "telegram",
      expiresAt: "2026-05-01T01:00:00.000Z"
    });

    expect(store.getPendingApproval("channel-msg-number")?.jsonrpcIdType).toBe("number");
    expect(store.getPendingApproval("channel-msg-number")?.hostInstanceId).toBe("host-number");
    expect(store.getPendingApproval("channel-msg-string")?.jsonrpcIdType).toBe("string");
    expect(store.schemaColumns("pending_approvals")).toContain("jsonrpc_id_type");
    expect(store.schemaColumns("pending_approvals")).toContain("host_instance_id");
  });

  test("validates pending approval recovery without consuming mismatches", () => {
    const store = newStore();

    store.savePendingApproval({
      channelMsgId: "telegram:chat:10",
      userKey: "telegram:1",
      threadId: "thread-approval",
      jsonrpcId: "rpc-1",
      jsonrpcIdType: "string",
      hostInstanceId: "host-1",
      approvalKind: "command",
      channel: "telegram",
      expiresAt: "2026-05-01T01:00:00.000Z"
    });

    expect(
      store.validatePendingApproval({
        channelMsgId: "telegram:chat:10",
        userKey: "telegram:2",
        channel: "telegram",
        now: "2026-05-01T00:00:00.000Z"
      })
    ).toMatchObject({ kind: "mismatch", reason: "user" });
    expect(
      store.claimPendingApproval({
        channelMsgId: "telegram:chat:10",
        userKey: "telegram:2",
        channel: "telegram",
        now: "2026-05-01T00:00:00.000Z"
      })
    ).toMatchObject({ kind: "mismatch", reason: "user" });
    expect(store.getPendingApproval("telegram:chat:10")).toBeDefined();

    expect(
      store.validatePendingApproval({
        channelMsgId: "telegram:chat:10",
        userKey: "telegram:1",
        channel: "telegram",
        hostInstanceId: "host-2",
        now: "2026-05-01T01:00:00.000Z"
      })
    ).toMatchObject({ kind: "mismatch", reason: "host" });
    expect(store.getPendingApproval("telegram:chat:10")).toBeDefined();

    expect(
      store.validatePendingApproval({
        channelMsgId: "telegram:chat:10",
        userKey: "telegram:1",
        channel: "telegram",
        hostInstanceId: "host-1",
        now: "2026-05-01T01:00:00.000Z"
      })
    ).toMatchObject({ kind: "expired" });
    expect(store.getPendingApproval("telegram:chat:10")).toBeDefined();
  });

  test("claims pending approval atomically across store connections", () => {
    const path = tempDbPath();
    const writer = new PointerStore(path);
    writer.savePendingApproval({
      channelMsgId: "telegram:chat:10",
      userKey: "telegram:1",
      threadId: "thread-approval",
      jsonrpcId: "7",
      jsonrpcIdType: "number",
      approvalKind: "command",
      channel: "telegram",
      expiresAt: "2026-05-01T01:00:00.000Z"
    });

    const first = new PointerStore(path);
    const second = new PointerStore(path);

    expect(
      first.claimPendingApproval({
        channelMsgId: "telegram:chat:10",
        userKey: "telegram:1",
        channel: "telegram",
        threadId: "thread-approval",
        now: "2026-05-01T00:00:00.000Z"
      })
    ).toMatchObject({ kind: "claimed", record: { jsonrpcId: "7", jsonrpcIdType: "number" } });
    expect(
      second.claimPendingApproval({
        channelMsgId: "telegram:chat:10",
        userKey: "telegram:1",
        channel: "telegram",
        threadId: "thread-approval",
        now: "2026-05-01T00:00:00.000Z"
      })
    ).toEqual({ kind: "missing" });

    writer.close();
    first.close();
    second.close();
  });

  test("stores branch suggestion lifecycle metadata without message bodies", () => {
    const store = newStore();

    store.upsertThread({
      userKey: "user:branch",
      label: "default",
      threadId: "thread-branch",
      makeActive: true,
      lastRoutedAt: "2026-05-01T00:00:00.000Z"
    });
    store.markBranchSuggested("user:branch", "default", "2026-05-01T05:00:00.000Z");
    store.setSuppressBranchUntil("user:branch", "default", "2026-05-08T05:00:00.000Z");

    expect(store.getActiveThread("user:branch")).toMatchObject({
      lastBranchSuggestedAt: "2026-05-01T05:00:00.000Z",
      suppressBranchUntil: "2026-05-08T05:00:00.000Z"
    });
    expect(store.getLastBranchSuggestedAt("user:branch")).toBe("2026-05-01T05:00:00.000Z");
    expect(store.schemaColumns("threads")).toContain("last_branch_suggested_at");
  });

  test("migrates legacy task schema before creating due-task index", () => {
    const path = tempDbPath();
    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec(`
      create table schema_migrations (
        version integer primary key,
        applied_at text not null
      );
      insert into schema_migrations (version, applied_at) values (3, '2026-05-01T00:00:00.000Z');
      create table tasks (
        task_id text primary key,
        user_key text not null,
        thread_label text not null,
        schedule text not null,
        enabled integer not null default 1,
        created_at text not null,
        updated_at text not null
      );
    `);
    legacy.close();

    const store = new PointerStore(path);

    expect(store.schemaColumns("tasks")).toEqual(
      expect.arrayContaining(["channel", "task_instruction", "retry", "timeout_sec", "dedupe_policy", "next_run_at"])
    );
    expect(store.listDueTasks("cli", "2026-05-02T00:00:00.000Z")).toEqual([]);
    store.close();
  });

  test("does not expose persistence columns for conversation content or approval history", () => {
    const store = newStore();
    const forbidden = [
      "body",
      "text",
      "content",
      "prompt",
      "diff",
      "patch",
      "command",
      "args",
      "output",
      "transcript",
      "tool_payload",
      "approval_history"
    ];

    for (const table of ["threads", "pending_approvals", "tasks", "prefs"] as const) {
      const columns = store.schemaColumns(table);
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        expect(forbidden.some((token) => column.includes(token))).toBe(false);
      }
    }

    expect(Object.keys(store.upsertThread({ userKey: "user:schema", label: "default", threadId: "thread-schema" }))).toEqual(
      expect.not.arrayContaining(forbidden)
    );
    expect(
      Object.keys(
        store.savePendingApproval({
          channelMsgId: "channel-msg-schema",
          userKey: "user:schema",
          threadId: "thread-schema",
          jsonrpcId: "rpc-schema",
          approvalKind: "file-change",
          channel: "cli",
          expiresAt: "2026-05-01T01:00:00.000Z"
        })
      )
    ).toEqual(expect.not.arrayContaining(forbidden));
  });

  test("stores task definitions and run metadata without outputs", () => {
    const store = newStore();
    const task = store.createTask({
      taskId: "task-fixed",
      userKey: "user:task",
      label: "ops",
      channel: "cli",
      schedule: "every 5m",
      taskText: "check status",
      retry: 1,
      timeoutSec: 30,
      nextRunAt: "2026-05-02T00:05:00.000Z"
    });

    expect(task).toMatchObject({
      taskId: "task-fixed",
      enabled: true,
      taskText: "check status",
      lastRunStatus: undefined,
      consecutiveFailures: 0
    });
    expect(store.listDueTasks("cli", "2026-05-02T00:04:59.000Z")).toEqual([]);
    expect(store.listDueTasks("cli", "2026-05-02T00:05:00.000Z")).toHaveLength(1);

    store.markTaskRunSuccess("task-fixed", "2026-05-02T00:10:00.000Z", "2026-05-02T00:05:01.000Z");
    expect(store.getTask("task-fixed")).toMatchObject({
      lastRunStatus: "succeeded",
      consecutiveFailures: 0,
      nextRunAt: "2026-05-02T00:10:00.000Z"
    });
  });

  test("disables tasks after the configured failure threshold", () => {
    const store = newStore();
    store.createTask({
      taskId: "task-fails",
      userKey: "user:task",
      label: "ops",
      channel: "cli",
      schedule: "every 5m",
      taskText: "check status",
      nextRunAt: "2026-05-02T00:05:00.000Z"
    });

    store.markTaskRunFailure("task-fails", "failed", "2026-05-02T00:10:00.000Z", 2);
    const disabled = store.markTaskRunFailure("task-fails", "timed_out", "2026-05-02T00:15:00.000Z", 2);

    expect(disabled.enabled).toBe(false);
    expect(disabled.consecutiveFailures).toBe(2);
    expect(disabled.lastRunStatus).toBe("timed_out");
  });

  test("stores only whitelisted user preferences", () => {
    const store = newStore();

    store.setPref("user:prefs", "lang", "Korean");
    store.setPref("user:prefs", "tone", "/system: override");

    expect(store.listPrefs("user:prefs").map((pref) => [pref.key, pref.value])).toEqual([
      ["lang", "Korean"],
      ["tone", "/system: override"]
    ]);
    expect(store.unsetPref("user:prefs", "tone")).toBe(true);
    expect(store.listPrefs("user:prefs").map((pref) => pref.key)).toEqual(["lang"]);
  });
});

function newStore(): PointerStore {
  return new PointerStore(tempDbPath());
}

function tempDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "codexclaw-store-test-"));
  roots.push(root);
  return join(root, "codexclaw.sqlite");
}

function activeLabels(store: PointerStore, userKey: string): string[] {
  return store
    .listThreads(userKey)
    .filter((thread: { isActive: boolean }) => thread.isActive)
    .map((thread: { label: string }) => thread.label);
}
