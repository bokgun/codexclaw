import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

type SqliteDatabaseConstructor = new (filename?: string) => {
  exec(sql: string): void;
  query<T = unknown, P extends unknown[] = unknown[]>(sql: string): {
    get(...params: P): T | null;
    all(...params: P): T[];
    run(...params: P): void;
  };
  close(): void;
};

type ThreadRow = {
  user_key: string;
  label: string;
  thread_id: string;
  is_default: number;
  status: "active" | "archived";
  last_routed_at: string | null;
  suppress_branch_until: string | null;
};

const dir = await mkdtemp(join(tmpdir(), "codexclaw-m0-pointer-"));
const dbPath = join(dir, "pointers.sqlite");
const { Database } = (await importBunSqlite()) as { Database: SqliteDatabaseConstructor };
const db = new Database(dbPath);

try {
  db.exec(`
    CREATE TABLE threads (
      user_key TEXT NOT NULL,
      label TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      last_routed_at TEXT,
      suppress_branch_until TEXT DEFAULT NULL,
      PRIMARY KEY (user_key, label)
    )
  `);

  const upsert = db.query<void, [string, string, string, number, string]>(`
    INSERT INTO threads (user_key, label, thread_id, is_default, last_routed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_key, label) DO UPDATE SET
      thread_id = excluded.thread_id,
      is_default = excluded.is_default,
      last_routed_at = excluded.last_routed_at
  `);

  const now = new Date().toISOString();
  upsert.run("user:m0", "default", "thread-default", 1, now);
  upsert.run("user:m0", "ops", "thread-ops", 0, now);

  db.query<void, [string, string]>("UPDATE threads SET status = 'archived' WHERE user_key = ? AND label = ?").run(
    "user:m0",
    "ops"
  );

  const rows = db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE user_key = ? ORDER BY label").all("user:m0");
  assertPointerRows(rows, now);

  console.error(`[probe] sqlite=${dbPath}`);
  for (const row of rows) {
    console.error(
      [
        "[probe] pointer",
        `user_key=${row.user_key}`,
        `label=${row.label}`,
        `thread_id=${row.thread_id}`,
        `is_default=${row.is_default}`,
        `status=${row.status}`,
        `last_routed_at=${row.last_routed_at ? "set" : "null"}`,
        `suppress_branch_until=${row.suppress_branch_until === null ? "null" : "set"}`
      ].join(" ")
    );
  }
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}

function importBunSqlite(): Promise<unknown> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  return dynamicImport("bun:sqlite");
}

function assertPointerRows(rows: ThreadRow[], expectedTimestamp: string): void {
  if (rows.length !== 2) throw new Error(`Expected 2 pointer rows, got ${rows.length}`);

  const defaultRow = rows.find((row) => row.label === "default");
  if (!defaultRow) throw new Error("Missing default pointer row");
  if (defaultRow.thread_id !== "thread-default") throw new Error("Default pointer thread_id mismatch");
  if (defaultRow.is_default !== 1) throw new Error("Default pointer is_default mismatch");
  if (defaultRow.status !== "active") throw new Error("Default pointer status mismatch");

  const opsRow = rows.find((row) => row.label === "ops");
  if (!opsRow) throw new Error("Missing ops pointer row");
  if (opsRow.thread_id !== "thread-ops") throw new Error("Ops pointer thread_id mismatch");
  if (opsRow.is_default !== 0) throw new Error("Ops pointer is_default mismatch");
  if (opsRow.status !== "archived") throw new Error("Ops pointer status mismatch");

  for (const row of rows) {
    if (row.user_key !== "user:m0") throw new Error(`Unexpected user_key for ${row.label}`);
    if (row.last_routed_at !== expectedTimestamp) throw new Error(`last_routed_at mismatch for ${row.label}`);
    if (row.suppress_branch_until !== null) throw new Error(`suppress_branch_until should be null for ${row.label}`);
  }
}
