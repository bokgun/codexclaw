import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { WikiConfig, WikiLintFinding, WikiPage, WikiSourceRef } from "./types.js";
import { requireWikiEnabled } from "./config.js";
import { listWikiPages, pageLinkTarget } from "./manifest.js";
import { isWithinAllowedRoot, rejectCodexOwnedPath } from "./paths.js";
import { canReadPage } from "./query.js";

const DISALLOWED_PATTERNS: readonly [RegExp, string][] = [
  [/"type"\s*:\s*"event_msg"/i, "Codex rollout JSONL fragment candidate"],
  [/"tool_call"|tool_calls?|function_call/i, "tool call payload candidate"],
  [/^diff --git\s+/im, "diff payload candidate"],
  [/\bapproval_(history|decision)\b/i, "approval history candidate"],
  [/\bconversation body\b/i, "conversation body replica candidate"]
];

export function lintWiki(config: WikiConfig, options: { userKey?: string } = {}): WikiLintFinding[] {
  requireWikiEnabled(config);
  const pages = listWikiPages(config).filter((page) => !options.userKey || canReadPage(page, options.userKey));
  const findings: WikiLintFinding[] = [];
  const pageNames = new Set(pages.map((page) => basename(page.path)));
  const linkedPages = new Set<string>();
  const titles = new Map<string, WikiPage[]>();

  for (const page of pages) {
    titles.set(page.meta.title.toLowerCase(), [...(titles.get(page.meta.title.toLowerCase()) ?? []), page]);
    lintMissingSources(page, findings);
    lintStaleSources(config, page, findings);
    lintBrokenLinks(page, pageNames, linkedPages, findings);
    lintDisallowedContent(page, findings);
  }

  for (const page of pages) {
    if (!linkedPages.has(basename(page.path)) && pages.length > 1) {
      findings.push(finding("info", "orphan_page", page, "Page is not linked from another wiki page"));
    }
  }

  for (const duplicates of titles.values()) {
    if (duplicates.length > 1) {
      for (const page of duplicates) {
        findings.push(finding("info", "contradiction_candidate", page, "Duplicate title may need human review"));
      }
    }
  }

  return findings;
}

export function renderLintReport(
  findings: readonly WikiLintFinding[],
  meta?: { visibility: "user_private"; ownerUserKey: string; generatedAt?: Date }
): string {
  const lines = meta
    ? [
        "---",
        "codexclawWikiLint: v1",
        `meta: ${JSON.stringify({ visibility: meta.visibility, ownerUserKey: meta.ownerUserKey, generatedAt: (meta.generatedAt ?? new Date()).toISOString() })}`,
        "---",
        "",
        "# Wiki Lint Report",
        ""
      ]
    : ["# Wiki Lint Report", ""];
  for (const item of findings) {
    lines.push(`- ${item.severity} ${item.kind}: ${item.pagePath}`);
    lines.push(`  ${item.message}`);
    if (item.contentHash) lines.push(`  contentHash: ${item.contentHash}`);
    if (item.redactedSnippet) lines.push(`  redactedSnippet: ${item.redactedSnippet}`);
  }
  return `${lines.join("\n")}\n`;
}

function lintMissingSources(page: WikiPage, findings: WikiLintFinding[]): void {
  if (page.meta.sourceRefs.length === 0) {
    findings.push(finding("warning", "missing_source_ref", page, "Wiki page has no source references"));
  }
}

function lintStaleSources(config: WikiConfig, page: WikiPage, findings: WikiLintFinding[]): void {
  for (const ref of page.meta.sourceRefs) {
    if (!ref.resolvedPath || ref.kind !== "repo_file") continue;
    try {
      rejectCodexOwnedPath(ref.resolvedPath);
      if (!isWithinAllowedRoot(ref.resolvedPath, config.allowedSourceRoots)) {
        findings.push(finding("warning", "stale_source_ref", page, `Source is outside allowed roots: ${ref.displayPath}`, [ref]));
        continue;
      }
      if (!existsSync(ref.resolvedPath)) {
        findings.push(finding("warning", "stale_source_ref", page, `Source no longer exists: ${ref.displayPath}`, [ref]));
        continue;
      }
      if (ref.contentHash) {
        const currentHash = `sha256:${createHash("sha256").update(readFileSync(ref.resolvedPath, "utf8")).digest("hex")}`;
        if (currentHash !== ref.contentHash) {
          findings.push(finding("warning", "stale_source_ref", page, `Source hash changed: ${ref.displayPath}`, [ref], currentHash));
        }
      }
    } catch {
      findings.push(finding("warning", "stale_source_ref", page, `Source cannot be verified: ${ref.displayPath}`, [ref]));
    }
  }
}

function lintBrokenLinks(page: WikiPage, pageNames: ReadonlySet<string>, linkedPages: Set<string>, findings: WikiLintFinding[]): void {
  const linkRegex = /\[[^\]]+\]\(([^)]+\.md)\)/g;
  for (const match of page.body.matchAll(linkRegex)) {
    const target = pageLinkTarget(match[1]!);
    linkedPages.add(target);
    if (!pageNames.has(target)) {
      findings.push(finding("warning", "broken_link", page, `Markdown link target does not exist: ${match[1]}`));
    }
  }
}

function lintDisallowedContent(page: WikiPage, findings: WikiLintFinding[]): void {
  for (const [pattern, message] of DISALLOWED_PATTERNS) {
    if (!pattern.test(page.body)) continue;
    findings.push(finding("error", "disallowed_content_candidate", page, message, page.meta.sourceRefs, redactedHash(page.body), "[redacted forbidden content candidate]"));
  }
}

function finding(
  severity: WikiLintFinding["severity"],
  kind: WikiLintFinding["kind"],
  page: WikiPage,
  message: string,
  sourceRefs: readonly WikiSourceRef[] = page.meta.sourceRefs,
  contentHash?: string,
  redactedSnippet?: string
): WikiLintFinding {
  return {
    severity,
    kind,
    pagePath: join("pages", basename(page.path)),
    message,
    sourceRefs,
    contentHash,
    redactedSnippet
  };
}

function redactedHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
