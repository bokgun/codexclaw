import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CodexRuntimeClient, CodexThreadMetadata } from "../codex/runtime-client.js";
import type { JsonValue } from "../codex/ws-client.js";
import type { PointerStore } from "../store/pointer-store.js";
import type { RuntimeLogger } from "./log.js";
import type { ThreadRecord } from "./types.js";
import { RoutingError } from "./errors.js";

export type ObservedThreadState = "active" | "archived" | "missing" | "unknown";

export interface ThreadMetadata {
  threadId: string;
  cwd: string;
  archived: boolean;
  status: string;
}

export interface ThreadSyncOptions {
  workspaceRoot: string;
  pageLimit?: number;
  pageSize?: number;
  logger?: RuntimeLogger;
}

export interface ThreadSyncResult {
  checkedPointers: number;
  markedActive: number;
  markedArchived: number;
  markedMissing: number;
  preservedQuarantined: number;
  warnings: readonly string[];
}

interface ListedThreads {
  complete: boolean;
  byId: Map<string, ThreadMetadata>;
  warnings: string[];
}

const DEFAULT_PAGE_LIMIT = 5;
const DEFAULT_PAGE_SIZE = 100;
const NOT_FOUND_PATTERN = /(not\s*found|missing|unknown\s+thread|no\s+such|does\s+not\s+exist|no\s+rollout\s+found)/i;

export async function syncThreadPointers(
  store: PointerStore,
  codex: CodexRuntimeClient,
  options: ThreadSyncOptions
): Promise<ThreadSyncResult> {
  const workspaceRoot = normalizePathForCompare(options.workspaceRoot);
  const active = await collectListedThreads(codex, workspaceRoot, false, options);
  const archived = await collectListedThreads(codex, workspaceRoot, true, options);
  const warnings = [...active.warnings, ...archived.warnings];
  const complete = active.complete && archived.complete;
  const archivedIds = archived.byId;
  const activeIds = active.byId;
  const ambiguousIds = intersectIds(activeIds, archivedIds);
  const result = {
    checkedPointers: 0,
    markedActive: 0,
    markedArchived: 0,
    markedMissing: 0,
    preservedQuarantined: 0,
    warnings
  };

  for (const pointer of store.listAllThreads()) {
    result.checkedPointers += 1;
    if (pointer.status === "quarantined") {
      result.preservedQuarantined += 1;
      continue;
    }

    if (ambiguousIds.has(pointer.threadId)) {
      warnings.push(`thread_list_ambiguous:${pointer.threadId}`);
      continue;
    }

    if (activeIds.has(pointer.threadId)) {
      if (!archived.complete) {
        warnings.push(`thread_list_archived_incomplete:${pointer.threadId}`);
        continue;
      }
      if (pointer.status !== "active") {
        store.markThreadStatus(pointer.userKey, pointer.label, "active");
        result.markedActive += 1;
      }
      continue;
    }

    if (archivedIds.has(pointer.threadId)) {
      if (!active.complete) {
        warnings.push(`thread_list_active_incomplete:${pointer.threadId}`);
        continue;
      }
      if (pointer.status !== "archived") {
        store.markThreadStatus(pointer.userKey, pointer.label, "archived");
        result.markedArchived += 1;
      }
      continue;
    }

    if (!complete) continue;

    const observed = await readObservedThreadState(codex, pointer.threadId, workspaceRoot, {
      classifyFromRead: false
    });
    if (observed.state === "active" || observed.state === "archived") {
      const status = observed.state;
      if (pointer.status !== status) {
        store.markThreadStatus(pointer.userKey, pointer.label, status);
        if (status === "active") result.markedActive += 1;
        else result.markedArchived += 1;
      }
      continue;
    }

    if (observed.state === "missing") {
      if (pointer.status !== "missing") {
        store.markThreadStatus(pointer.userKey, pointer.label, "missing");
        result.markedMissing += 1;
      }
      continue;
    }

    if (observed.reason === "cwd_mismatch") {
      store.markThreadStatus(pointer.userKey, pointer.label, "quarantined");
      warnings.push(`thread_sync_cwd_mismatch:${pointer.threadId}`);
      continue;
    }

    warnings.push(`thread_sync_unknown:${pointer.threadId}`);
  }

  for (const warning of warnings.slice(0, 10)) {
    if (warning.startsWith("thread_sync_unknown:")) options.logger?.debug("thread_sync_warning", { warning });
    else options.logger?.warn("thread_sync_warning", { warning });
  }
  return result;
}

export async function assertThreadRoutable(
  store: PointerStore,
  codex: CodexRuntimeClient,
  record: ThreadRecord,
  workspaceRoot: string
): Promise<void> {
  if (record.status !== "active") {
    throw notRoutable(record);
  }

  const observed = await readObservedThreadState(codex, record.threadId, normalizePathForCompare(workspaceRoot), {
    verifyListMembership: true
  });
  if (observed.state === "active") return;

  if (observed.state === "archived" || observed.state === "missing") {
    store.markThreadStatus(record.userKey, record.label, observed.state);
  }
  if (observed.reason === "cwd_mismatch") {
    store.markThreadStatus(record.userKey, record.label, "quarantined");
    throw notRoutable({ ...record, status: "quarantined" });
  }

  throw notRoutable({ ...record, status: observed.state === "unknown" ? record.status : observed.state });
}

export async function readObservedThreadState(
  codex: CodexRuntimeClient,
  threadId: string,
  workspaceRoot: string,
  options: { verifyListMembership?: boolean; classifyFromRead?: boolean; pageLimit?: number; pageSize?: number } = {}
): Promise<{ state: ObservedThreadState; metadata?: ThreadMetadata; reason?: string }> {
  try {
    const response: JsonValue =
      typeof (codex as unknown as { readThreadMetadata?: (threadId: string) => Promise<JsonValue> }).readThreadMetadata === "function"
        ? ((await codex.readThreadMetadata(threadId)) as unknown as JsonValue)
        : await codex.readThread(threadId, false);
    const metadata = metadataFromReadResponse(response);
    if (!metadata) return { state: "unknown", reason: "missing_thread_metadata" };
    if (!sameNormalizedPath(metadata.cwd, workspaceRoot)) {
      return { state: "unknown", metadata, reason: "cwd_mismatch" };
    }
    if (options.verifyListMembership) {
      const listed = await findThreadInLists(codex, threadId, workspaceRoot, options);
      if (listed.state !== "unknown") return listed;
      if (listed.reason === "not_listed") {
        return { state: metadata.archived ? "archived" : "active", metadata, reason: "read_verified_unlisted" };
      }
      return { state: "unknown", metadata, reason: listed.reason ?? "list_membership_unknown" };
    }
    if (options.classifyFromRead === false) {
      return { state: "unknown", metadata, reason: "read_metadata_exists" };
    }
    return { state: metadata.archived ? "archived" : "active", metadata };
  } catch (error) {
    if (isThreadNotFoundError(error)) return { state: "missing", reason: "not_found" };
    return { state: "unknown", reason: boundedErrorShape(error) };
  }
}

export function metadataFromThread(
  thread: Pick<CodexThreadMetadata, "id" | "cwd" | "status"> & { archived?: boolean },
  archivedOverride?: boolean
): ThreadMetadata {
  const status = statusToString(thread.status);
  return {
    threadId: thread.id,
    cwd: String(thread.cwd),
    archived: archivedOverride ?? (typeof thread.archived === "boolean" ? thread.archived : /archiv/i.test(status)),
    status
  };
}

export function metadataFromReadResponse(value: JsonValue): ThreadMetadata | undefined {
  const object = asObject(value);
  const nested = asObject(object.thread);
  const thread = Object.keys(nested).length > 0 ? nested : object;
  const id = readString(thread, "id");
  const cwd = readString(thread, "cwd");
  if (!id || !cwd) return undefined;
  return metadataFromThread(thread as unknown as Pick<CodexThreadMetadata, "id" | "cwd" | "status"> & { archived?: boolean });
}

export function isThreadNotFoundError(error: unknown): boolean {
  const shape = boundedErrorShape(error);
  return NOT_FOUND_PATTERN.test(shape);
}

export function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  const normalized = existsSync(resolved) ? realpathSync(resolved) : resolved;
  return normalized.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function sameNormalizedPath(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function notRoutable(record: Pick<ThreadRecord, "label" | "status">): RoutingError {
  if (record.status === "active") {
    return new RoutingError(
      `Thread '${record.label}' is locally active but could not be verified in the connected Codex app-server. Create /thread new, or use /thread switch only when recovering a verified archived label.`,
      "thread_not_routable"
    );
  }
  return new RoutingError(
    `Thread '${record.label}' is ${record.status}; create /thread new or explicitly recover an archived label with /thread switch.`,
    "thread_not_routable"
  );
}

async function collectListedThreads(
  codex: CodexRuntimeClient,
  workspaceRoot: string,
  archived: boolean,
  options: ThreadSyncOptions
): Promise<ListedThreads> {
  const byId = new Map<string, ThreadMetadata>();
  const warnings: string[] = [];
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const limit = options.pageSize ?? DEFAULT_PAGE_SIZE;
  let cursor: string | null | undefined;

  for (let page = 0; page < pageLimit; page += 1) {
    try {
      const response = await codex.listThreads({
        cursor,
        limit,
        archived,
        cwd: workspaceRoot,
        useStateDbOnly: false
      });
      for (const thread of response.data) {
        const metadata = metadataFromThread(thread, archived);
        if (sameNormalizedPath(metadata.cwd, workspaceRoot)) byId.set(metadata.threadId, metadata);
      }
      cursor = response.nextCursor;
      if (!cursor) return { complete: true, byId, warnings };
    } catch (error) {
      warnings.push(`thread_list_${archived ? "archived" : "active"}:${boundedErrorShape(error)}`);
      return { complete: false, byId, warnings };
    }
  }

  if (cursor) warnings.push(`thread_list_page_limit:${archived ? "archived" : "active"}`);
  return { complete: !cursor, byId, warnings };
}

async function findThreadInLists(
  codex: CodexRuntimeClient,
  threadId: string,
  workspaceRoot: string,
  options: { pageLimit?: number; pageSize?: number }
): Promise<{ state: ObservedThreadState; metadata?: ThreadMetadata; reason?: string }> {
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const active = await collectListedThreads(codex, workspaceRoot, false, { workspaceRoot, pageLimit, pageSize });
  const activeMetadata = active.byId.get(threadId);
  if (!active.complete && !activeMetadata) return { state: "unknown", reason: "partial_active_list" };

  const archived = await collectListedThreads(codex, workspaceRoot, true, { workspaceRoot, pageLimit, pageSize });
  const archivedMetadata = archived.byId.get(threadId);
  if (activeMetadata && archivedMetadata) {
    return { state: "unknown", metadata: activeMetadata, reason: "ambiguous_list_membership" };
  }
  if (archivedMetadata) return { state: "archived", metadata: archivedMetadata };
  if (activeMetadata) {
    if (!archived.complete) return { state: "unknown", metadata: activeMetadata, reason: "partial_archived_list" };
    return { state: "active", metadata: activeMetadata };
  }
  if (!archived.complete) return { state: "unknown", reason: "partial_archived_list" };
  return { state: "unknown", reason: "not_listed" };
}

function intersectIds(left: Map<string, unknown>, right: Map<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const id of left.keys()) {
    if (right.has(id)) ids.add(id);
  }
  return ids;
}

function boundedErrorShape(error: unknown): string {
  if (error instanceof Error) return `${error.name}:${error.message}`.slice(0, 160);
  return String(error).slice(0, 160);
}

function statusToString(status: unknown): string {
  if (typeof status === "string") return status;
  if (status && typeof status === "object" && !Array.isArray(status) && "type" in status) {
    const type = (status as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return "unknown";
}

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readString(object: Record<string, JsonValue>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}
