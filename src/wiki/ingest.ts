import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { WikiConfig, WikiIngestManifest, WikiIngestRequest, WikiIngestResult, WikiNoteRequest, WikiPageMeta, WikiSourceRef } from "./types.js";
import { requireWikiEnabled } from "./config.js";
import { normalizeSlug, normalizeSourcePath } from "./paths.js";
import { writeIngestManifest, writeWikiPage } from "./manifest.js";

export function ingestWikiFiles(config: WikiConfig, request: WikiIngestRequest): WikiIngestResult {
  requireWikiEnabled(config);
  const now = request.now ?? new Date();
  const slug = normalizeSlug(request.targetSlug ?? request.title ?? "wiki-ingest");
  const sourceRefs = request.sourcePaths.map((path) => sourceRefWithHash(config, path, now));
  const title = request.title?.trim() || titleFromSlug(slug);
  const ownerUserKey = request.visibility === "user_private" ? request.userKey : undefined;
  const requestedFocus = normalizeOptionalWikiText(config, request.requestedFocus, "wiki ingest focus");
  const body = [
    `# ${title}`,
    "",
    requestedFocus ? `Focus: ${requestedFocus}` : undefined,
    "This page was compiled from explicitly selected source references. Raw repository source content is not copied into hidden wiki storage.",
    "",
    "## Sources",
    ...sourceRefs.map((ref) => `- ${ref.displayPath}${ref.contentHash ? ` (${ref.contentHash.slice(0, 16)})` : ""}`),
    "",
    "Add user notes or selected summaries when wiki context needs human-curated detail."
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  const page = writeWikiPage(config, pageMeta(title, slug, request.visibility, ownerUserKey, sourceRefs, now), body);
  const manifest = ingestManifest("ingest_files", request.userKey, page.path, slug, request.visibility, ownerUserKey, sourceRefs, now, requestedFocus);
  return { page, manifest, pagePath: page.path, manifestPath: writeIngestManifest(config, manifest) };
}

export function addWikiNote(config: WikiConfig, request: WikiNoteRequest): WikiIngestResult {
  requireWikiEnabled(config);
  const now = request.now ?? new Date();
  const slug = normalizeSlug(request.targetSlug ?? request.title);
  const title = request.title.trim();
  if (!title) throw new Error("Wiki note title is required");
  const ownerUserKey = request.visibility === "user_private" ? request.userKey : undefined;
  assertWikiContentAllowed(request.body, "wiki note");
  const sourceRefs: WikiSourceRef[] = [
    {
      kind: "user_note",
      displayPath: `user-note:${slug}`,
      observedAt: now.toISOString(),
      contentHash: hashText(request.body)
    }
  ];
  const body = [`# ${title}`, "", "Source: explicit user-provided note.", "", request.body.trim()].join("\n");
  const page = writeWikiPage(config, pageMeta(title, slug, request.visibility, ownerUserKey, sourceRefs, now), body);
  const manifest = ingestManifest("user_note", request.userKey, page.path, slug, request.visibility, ownerUserKey, sourceRefs, now);
  return { page, manifest, pagePath: page.path, manifestPath: writeIngestManifest(config, manifest) };
}

export function captureSelectedWikiText(
  config: WikiConfig,
  request: WikiNoteRequest & { targetSlug?: string }
): WikiIngestResult {
  requireWikiEnabled(config);
  const now = request.now ?? new Date();
  const slug = normalizeSlug(request.targetSlug ?? request.title);
  const title = request.title.trim();
  if (!title) throw new Error("Wiki capture title is required");
  const ownerUserKey = request.visibility === "user_private" ? request.userKey : undefined;
  assertWikiContentAllowed(request.body, "wiki capture");
  const sourceRefs: WikiSourceRef[] = [
    {
      kind: "selected_conversation_summary",
      displayPath: `selected-conversation-summary:${slug}`,
      observedAt: now.toISOString(),
      contentHash: hashText(request.body)
    }
  ];
  const body = [
    `# ${title}`,
    "",
    "Source: explicit user-selected conversation summary. Raw conversation remains in Codex rollout storage.",
    "",
    request.body.trim()
  ].join("\n");
  const page = writeWikiPage(config, pageMeta(title, slug, request.visibility, ownerUserKey, sourceRefs, now), body);
  const manifest = ingestManifest("selected_conversation_summary", request.userKey, page.path, slug, request.visibility, ownerUserKey, sourceRefs, now);
  return { page, manifest, pagePath: page.path, manifestPath: writeIngestManifest(config, manifest) };
}

function sourceRefWithHash(config: WikiConfig, path: string, now: Date): WikiSourceRef {
  const normalized = normalizeSourcePath(config, path, "repo_file", now);
  const text = readFileSync(normalized.ref.resolvedPath!, "utf8");
  if (text.includes("\u0000")) throw new Error(`Wiki source appears to be binary: ${path}`);
  return {
    ...normalized.ref,
    contentHash: hashText(text)
  };
}

function pageMeta(
  title: string,
  slug: string,
  visibility: "project_public" | "user_private",
  ownerUserKey: string | undefined,
  sourceRefs: readonly WikiSourceRef[],
  now: Date
): WikiPageMeta {
  return {
    title,
    slug,
    visibility,
    ownerUserKey,
    sourceRefs,
    tags: [],
    generatedAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function ingestManifest(
  operation: "ingest_files" | "user_note" | "selected_conversation_summary",
  userKey: string,
  pagePath: string,
  pageSlug: string,
  visibility: "project_public" | "user_private",
  ownerUserKey: string | undefined,
  sourceRefs: readonly WikiSourceRef[],
  now: Date,
  requestedFocus?: string
): WikiIngestManifest {
  return {
    version: 1,
    operation,
    generatedAt: now.toISOString(),
    userKey,
    pagePath,
    pageSlug,
    visibility,
    ownerUserKey,
    sourceRefs,
    requestedFocus
  };
}

function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

const FORBIDDEN_WIKI_CONTENT: readonly [RegExp, string][] = [
  [/"type"\s*:\s*"event_msg"/i, "Codex rollout JSONL fragment"],
  [/"tool_call"|tool_calls?|function_call/i, "tool call payload"],
  [/^diff --git\s+/im, "diff payload"],
  [/\bapproval_(history|decision)\b/i, "approval history"],
  [/\bconversation body\b/i, "conversation body replica"]
];

function assertWikiContentAllowed(text: string, label: string): void {
  for (const [pattern, reason] of FORBIDDEN_WIKI_CONTENT) {
    if (pattern.test(text)) throw new Error(`${label} contains forbidden wiki persistence content: ${reason}`);
  }
}

function normalizeOptionalWikiText(config: WikiConfig, text: string | undefined, label: string): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  assertWikiContentAllowed(trimmed, label);
  if (trimmed.length > config.maxExcerptChars) throw new Error(`${label} exceeds maxExcerptChars`);
  return trimmed;
}

function titleFromSlug(slug: string): string {
  return slug.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}
