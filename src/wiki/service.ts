import { relative } from "node:path";
import type { WikiCommandService } from "../runtime/router.js";
import { addWikiNote, captureSelectedWikiText, ingestWikiFiles } from "./ingest.js";
import { lintWiki, renderLintReport } from "./lint.js";
import { queryWiki } from "./query.js";
import type { WikiConfig } from "./types.js";
import { ensureWikiCategoryDir, wikiPath, writeSafeWikiFile } from "./paths.js";

export function createWikiCommandService(config: WikiConfig): WikiCommandService {
  return {
    async ingestFiles(input) {
      const result = ingestWikiFiles(config, {
        userKey: input.userKey,
        sourcePaths: input.paths,
        targetSlug: input.slug,
        requestedFocus: input.focus,
        visibility: input.visibility
      });
      return {
        pagePath: displayWikiPath(config, result.pagePath),
        manifestPath: displayWikiPath(config, result.manifestPath),
        sourceCount: result.page.meta.sourceRefs.length
      };
    },
    async addNote(input) {
      const result = addWikiNote(config, {
        userKey: input.userKey,
        title: input.title,
        body: input.body,
        visibility: input.visibility
      });
      return { pagePath: displayWikiPath(config, result.pagePath), manifestPath: displayWikiPath(config, result.manifestPath) };
    },
    async captureSelected(input) {
      const result = captureSelectedWikiText(config, {
        userKey: input.userKey,
        title: input.slug ?? "selected-conversation-summary",
        body: input.text,
        targetSlug: input.slug,
        visibility: input.visibility
      });
      return { pagePath: displayWikiPath(config, result.pagePath), manifestPath: displayWikiPath(config, result.manifestPath) };
    },
    async query(input) {
      return queryWiki(config, { userKey: input.userKey, queryText: input.query, limit: input.limit });
    },
    async lint(input) {
      const findings = lintWiki(config, { userKey: input.userKey });
      const reportPath = input.writeReport ? writeLintReport(config, findings, input.userKey) : undefined;
      return { findings, reportPath: reportPath ? displayWikiPath(config, reportPath) : undefined };
    }
  };
}

function writeLintReport(config: WikiConfig, findings: ReturnType<typeof lintWiki>, userKey: string): string {
  ensureWikiCategoryDir(config, "lint");
  const reportPath = wikiPath(config, "lint", `lint-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeSafeWikiFile(reportPath, renderLintReport(findings, { visibility: "user_private", ownerUserKey: userKey }));
  return reportPath;
}

function displayWikiPath(config: WikiConfig, path: string): string {
  return `wiki/${relative(config.wikiRoot, path)}`;
}
