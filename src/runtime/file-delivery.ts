import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { FileDeliveryPolicy, LocalDocumentRef, RejectedDocumentRef, TurnId } from "./types.js";

export type CandidatePathSource = "runtime_file_metadata";

export interface CandidatePath {
  rawText: string;
  turnId?: TurnId;
  source: CandidatePathSource;
}

export interface ValidationResult {
  accepted: readonly LocalDocumentRef[];
  rejected: readonly RejectedDocumentRef[];
}

export interface FileDeliveryTurnBinding {
  enabled: boolean;
  userKey: string;
  channelThreadKey?: string;
  startedAtMs?: number;
}

export class FileDeliveryCollector {
  private readonly turnState = new Map<
    string,
    Array<{ turnId?: TurnId; enabled: boolean; candidates: CandidatePath[]; seen: Set<string>; startedAtMs: number; overflow: number }>
  >();

  bindThread(threadId: string, binding: FileDeliveryTurnBinding): void {
    const states = (this.turnState.get(threadId) ?? []).filter((state) => state.turnId !== undefined);
    states.push({
      enabled: binding.enabled,
      candidates: [],
      seen: new Set(),
      startedAtMs: binding.startedAtMs ?? Date.now(),
      overflow: 0
    });
    this.turnState.set(threadId, states.slice(-2));
  }

  startTurn(threadId: string, turnId: TurnId | undefined): void {
    if (!turnId) return;
    const states = this.turnState.get(threadId);
    const pending = states?.find((state) => state.turnId === undefined);
    if (pending) pending.turnId = turnId;
  }

  collectAgentDelta(threadId: string, turnId: TurnId | undefined, delta: string, policy: FileDeliveryPolicy): void {
    void threadId;
    void turnId;
    void delta;
    void policy;
  }

  collectRuntimeFilePaths(threadId: string, turnId: TurnId | undefined, paths: readonly string[], policy: FileDeliveryPolicy): void {
    const state = this.stateFor(threadId, turnId);
    if (!state?.enabled || !policy.enabled) return;
    for (const path of paths) {
      const cleaned = cleanPathToken(path);
      if (!cleaned || looksUnsafeToken(cleaned)) continue;
      if (state.seen.has(cleaned)) continue;
      if (state.seen.size >= policy.maxCandidatesPerTurn || state.candidates.length >= policy.maxCandidatesPerTurn) {
        state.overflow += 1;
        continue;
      }
      state.seen.add(cleaned);
      state.candidates.push({ rawText: cleaned, turnId, source: "runtime_file_metadata" });
    }
  }

  finishTurn(threadId: string, turnId: TurnId | undefined, policy: FileDeliveryPolicy): ValidationResult | undefined {
    const states = this.turnState.get(threadId);
    const index = states?.findIndex((state) => matchesTurn(state.turnId, turnId) || state.turnId === undefined) ?? -1;
    const state = index >= 0 ? states?.[index] : undefined;
    if (states && index >= 0) {
      states.splice(index, 1);
      if (states.length === 0) this.turnState.delete(threadId);
      else this.turnState.set(threadId, states);
    }
    if (!state?.enabled || !policy.enabled) return undefined;
    const result = validateCandidatePaths(state.candidates, policy);
    if (state.overflow <= 0) return result;
    return {
      accepted: result.accepted,
      rejected: [...result.rejected, { displayPath: "additional candidates", reason: "limit_exceeded" }]
    };
  }

  clearThread(threadId: string): void {
    this.turnState.delete(threadId);
  }

  clear(): void {
    this.turnState.clear();
  }

  private stateFor(threadId: string, turnId: TurnId | undefined): { turnId?: TurnId; enabled: boolean; candidates: CandidatePath[]; seen: Set<string>; startedAtMs: number; overflow: number } | undefined {
    const states = this.turnState.get(threadId);
    if (!states) return undefined;
    const existing = states.find((state) => matchesTurn(state.turnId, turnId));
    if (existing) return existing;
    const pending = states.find((state) => state.turnId === undefined);
    if (!pending) return undefined;
    pending.turnId = turnId;
    return pending;
  }
}

function matchesTurn(stateTurnId: TurnId | undefined, eventTurnId: TurnId | undefined): boolean {
  if (stateTurnId === undefined || eventTurnId === undefined) return stateTurnId === eventTurnId;
  return stateTurnId === eventTurnId;
}

export function hasTelegramFileDeliveryIntent(text: string): boolean {
  const normalized = text.toLowerCase();
  const deliveryVerb = /\b(send|attach|upload|deliver|share)\b/.test(normalized);
  const fileNoun = /\b(file|document|doc|pdf|artifact|report|spreadsheet|csv|zip|txt|markdown|md|xlsx|docx|pptx)\b/.test(normalized);
  const generatedHint = /\b(generated|created|wrote|saved|output|result|this|that|the)\b/.test(normalized);
  const koreanDeliveryVerb = /(보내|전송|첨부|공유|올려|업로드)/.test(normalized);
  const koreanFileNoun = /(파일|문서|자료|결과물|리포트|보고서|첨부파일)/.test(normalized);
  const koreanGeneratedHint = /(생성|만든|작성|저장|결과|이|그|해당)/.test(normalized);
  return (deliveryVerb && fileNoun && generatedHint) || (koreanDeliveryVerb && koreanFileNoun && koreanGeneratedHint);
}

const TELEGRAM_FILE_DELIVERY_HOST_HINT = [
  "",
  "Codexclaw host capability context:",
  "- The user is talking through Telegram and explicitly asked for file delivery in this turn.",
  "- Do not say you lack Telegram, Bot API, chat_id, or sendDocument tools.",
  "- Do not call Telegram APIs yourself or ask the user for Telegram credentials.",
  "- Create the requested deliverable as a new file in the workspace during this turn. If the user asked to send an existing safe file, create a fresh copy artifact in the workspace during this turn.",
  "- After the turn completes, codexclaw will send successful newly added files from this turn to the current Telegram chat.",
  "- If no safe deliverable can be created, briefly explain why."
].join("\n");

export function attachTelegramFileDeliveryHostHint(text: string): string {
  if (text.includes("Codexclaw host capability context:")) return text;
  return `${text.trimEnd()}${TELEGRAM_FILE_DELIVERY_HOST_HINT}`;
}

export function validateCandidatePaths(candidates: readonly CandidatePath[], policy: FileDeliveryPolicy): ValidationResult {
  const accepted: LocalDocumentRef[] = [];
  const rejected: RejectedDocumentRef[] = [];
  const acceptedRealPaths = new Set<string>();
  const roots = policy.allowedRoots.map((root) => normalizeExistingDirectory(root)).filter(Boolean) as string[];
  const deniedRoots = policy.deniedRoots.map((root) => normalizeMaybeExistingPath(root)).filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (accepted.length >= policy.maxFilesPerTurn) {
      rejected.push({ displayPath: displayCandidate(candidate.rawText), reason: "limit_exceeded" });
      continue;
    }

    const resolved = resolveCandidatePath(candidate.rawText, policy.workspaceRoot);
    const validated = validateSinglePath(resolved, candidate, policy, roots, deniedRoots, acceptedRealPaths);
    if ("reason" in validated) rejected.push({ displayPath: displayCandidate(candidate.rawText), reason: validated.reason });
    else {
      accepted.push(validated);
      acceptedRealPaths.add(validated.absolutePath);
    }
  }

  return { accepted, rejected };
}

export function validateLocalDocumentForUpload(path: string, policy: FileDeliveryPolicy): LocalDocumentRef {
  const result = validateCandidatePaths([{ rawText: path, source: "runtime_file_metadata" }], { ...policy, maxFilesPerTurn: 1 });
  const accepted = result.accepted[0];
  if (!accepted) {
    const reason = result.rejected[0]?.reason ?? "missing";
    throw new Error(`Document is not deliverable: ${reason}`);
  }
  return accepted;
}

function validateSinglePath(
  path: string,
  candidate: CandidatePath,
  policy: FileDeliveryPolicy,
  roots: readonly string[],
  deniedRoots: readonly string[],
  acceptedRealPaths: ReadonlySet<string>
): LocalDocumentRef | { reason: RejectedDocumentRef["reason"] } {
  if (hasDeniedSegment(path, policy.deniedSegments) || isInsideAny(path, deniedRoots)) return { reason: "denied_path" };
  if (!existsSync(path)) return { reason: "missing" };
  if (lstatSync(path).isSymbolicLink()) {
    const real = realpathSync(path);
    if (!isInsideAny(real, roots)) return { reason: "symlink_escape" };
  }

  const realPath = realpathSync(path);
  if (hasDeniedSegment(realPath, policy.deniedSegments) || isInsideAny(realPath, deniedRoots)) return { reason: "denied_path" };
  if (!isInsideAny(realPath, roots)) return { reason: "outside_allowed_roots" };

  const stat = statSync(realPath);
  if (!stat.isFile()) return { reason: "not_regular_file" };
  if (stat.size > policy.maxFileBytes) return { reason: "too_large" };
  if (acceptedRealPaths.has(realPath)) return { reason: "duplicate" };
  return {
    absolutePath: realPath,
    displayName: basename(realPath),
    sizeBytes: stat.size,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    contentType: contentTypeForPath(realPath),
    source: candidate.source
  };
}

function resolveCandidatePath(rawText: string, workspaceRoot: string): string {
  if (isAbsolute(rawText)) return resolve(rawText);
  return resolve(workspaceRoot, rawText);
}

function normalizeExistingDirectory(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? normalizePath(real) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMaybeExistingPath(path: string): string | undefined {
  try {
    return normalizePath(existsSync(path) ? realpathSync(path) : path);
  } catch {
    return normalizePath(path);
  }
}

function isInsideAny(path: string, roots: readonly string[]): boolean {
  const candidate = normalizePath(path);
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
}

function hasDeniedSegment(path: string, deniedSegments: readonly string[]): boolean {
  const parts = normalizePath(path).split("/");
  return parts.some((part) => deniedSegments.includes(part) || isSensitivePathSegment(part));
}

function isSensitivePathSegment(segment: string): boolean {
  const normalized = segment.toLowerCase();
  if (normalized === ".env" || normalized.startsWith(".env.")) return true;
  if (normalized === ".ssh" || normalized === ".netrc" || normalized === ".npmrc" || normalized === ".pypirc") return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(normalized)) return true;
  if (normalized.endsWith(".pem") || normalized.endsWith(".key") || normalized.endsWith(".p12") || normalized.endsWith(".pfx")) return true;
  return /(^|[._-])(secret|secrets|token|tokens|credential|credentials|private-key|apikey|api-key)([._-]|$)/.test(normalized);
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
}

function cleanPathToken(raw: string): string {
  return raw.trim().replace(/[),.;:!?]+$/g, "");
}

function looksUnsafeToken(token: string): boolean {
  return token.includes("://") || token.includes("$(") || token.includes("${") || token.includes("*") || hasParentSegment(token);
}

function contentTypeForPath(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".zip":
      return "application/zip";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    default:
      return undefined;
  }
}

function displayCandidate(path: string): string {
  return basename(path) || dirname(path);
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}
