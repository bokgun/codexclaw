export type WikiVisibility = "project_public" | "user_private";

export type WikiArtifactKind = "compiled_page" | "user_note" | "ingest_manifest" | "lint_report";

export type WikiSourceKind = "repo_file" | "user_note" | "selected_conversation_summary";

export interface WikiConfig {
  enabled: boolean;
  wikiRoot: string;
  allowedSourceRoots: readonly string[];
  maxSourceBytes: number;
  maxQueryResults: number;
  maxExcerptChars: number;
}

export interface WikiSourceRef {
  kind: WikiSourceKind;
  displayPath: string;
  resolvedPath?: string;
  lineStart?: number;
  lineEnd?: number;
  contentHash?: string;
  observedAt: string;
}

export interface WikiPageMeta {
  title: string;
  slug: string;
  visibility: WikiVisibility;
  ownerUserKey?: string;
  sourceRefs: readonly WikiSourceRef[];
  tags: readonly string[];
  generatedAt: string;
  updatedAt: string;
}

export interface WikiPage {
  path: string;
  meta: WikiPageMeta;
  body: string;
}

export interface WikiIngestRequest {
  userKey: string;
  sourcePaths: readonly string[];
  targetSlug?: string;
  title?: string;
  requestedFocus?: string;
  visibility: WikiVisibility;
  now?: Date;
}

export interface WikiNoteRequest {
  userKey: string;
  title: string;
  body: string;
  targetSlug?: string;
  visibility: WikiVisibility;
  now?: Date;
}

export interface WikiIngestManifest {
  version: 1;
  operation: "ingest_files" | "user_note" | "selected_conversation_summary";
  generatedAt: string;
  userKey: string;
  pagePath: string;
  pageSlug: string;
  visibility: WikiVisibility;
  ownerUserKey?: string;
  sourceRefs: readonly WikiSourceRef[];
  requestedFocus?: string;
}

export interface WikiIngestResult {
  page: WikiPage;
  manifest: WikiIngestManifest;
  pagePath: string;
  manifestPath: string;
}

export interface WikiQueryRequest {
  userKey: string;
  queryText: string;
  limit?: number;
  includeSourceRefs?: boolean;
}

export interface WikiQueryResult {
  pagePath: string;
  title: string;
  excerpt: string;
  sourceRefs: readonly WikiSourceRef[];
  scoreReason: string;
}

export interface WikiLintFinding {
  severity: "error" | "warning" | "info";
  kind:
    | "broken_link"
    | "orphan_page"
    | "missing_source_ref"
    | "stale_source_ref"
    | "disallowed_content_candidate"
    | "contradiction_candidate";
  pagePath: string;
  message: string;
  sourceRefs: readonly WikiSourceRef[];
  redactedSnippet?: string;
  contentHash?: string;
}

export interface NormalizedWikiSource {
  ref: WikiSourceRef;
  size: number;
}
