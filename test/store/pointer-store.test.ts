import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
});

function newStore(): PointerStore {
  const root = mkdtempSync(join(tmpdir(), "codexclaw-store-test-"));
  roots.push(root);
  return new PointerStore(join(root, "codexclaw.sqlite"));
}

function activeLabels(store: PointerStore, userKey: string): string[] {
  return store
    .listThreads(userKey)
    .filter((thread: { isActive: boolean }) => thread.isActive)
    .map((thread: { label: string }) => thread.label);
}
