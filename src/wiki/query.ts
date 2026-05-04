import type { WikiConfig, WikiPage, WikiQueryRequest, WikiQueryResult } from "./types.js";
import { requireWikiEnabled } from "./config.js";
import { listWikiPages } from "./manifest.js";
import { basename, join } from "node:path";

export function queryWiki(config: WikiConfig, request: WikiQueryRequest): WikiQueryResult[] {
  requireWikiEnabled(config);
  const queryTerms = terms(request.queryText);
  if (queryTerms.length === 0) return [];
  const limit = Math.min(request.limit ?? config.maxQueryResults, config.maxQueryResults);

  return listWikiPages(config)
    .filter((page) => canReadPage(page, request.userKey))
    .map((page) => scorePage(page, queryTerms, config.maxExcerptChars, request.includeSourceRefs ?? true))
    .filter((result): result is WikiQueryResult & { score: number } => result !== undefined)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, limit)
    .map(({ score: _score, ...result }) => result);
}

export function canReadPage(page: WikiPage, userKey: string): boolean {
  return page.meta.visibility === "project_public" || page.meta.ownerUserKey === userKey;
}

function scorePage(page: WikiPage, queryTerms: readonly string[], maxExcerptChars: number, includeSourceRefs: boolean): (WikiQueryResult & { score: number }) | undefined {
  const haystack = `${page.meta.title}\n${page.meta.tags.join(" ")}\n${page.body}`.toLowerCase();
  const matched = queryTerms.filter((term) => haystack.includes(term));
  if (matched.length === 0) return undefined;
  const titleHit = matched.some((term) => page.meta.title.toLowerCase().includes(term));
  const score = matched.length + (titleHit ? 3 : 0);
  return {
    score,
    pagePath: join("pages", basename(page.path)),
    title: page.meta.title,
    excerpt: excerptFor(page.body, matched[0]!, maxExcerptChars),
    sourceRefs: includeSourceRefs ? page.meta.sourceRefs : [],
    scoreReason: titleHit ? "title/body match" : "body match"
  };
}

function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9_:-]+/).filter((term) => term.length >= 2))];
}

function excerptFor(body: string, term: string, maxChars: number): string {
  const compact = body.replace(/\s+/g, " ").trim();
  const index = compact.toLowerCase().indexOf(term);
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  const excerpt = compact.slice(start, start + maxChars);
  return `${start > 0 ? "..." : ""}${excerpt}${start + maxChars < compact.length ? "..." : ""}`;
}
