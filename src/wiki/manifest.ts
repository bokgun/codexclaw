import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { WikiConfig, WikiIngestManifest, WikiPage, WikiPageMeta } from "./types.js";
import { assertSafeExistingWikiCategoryDir, assertSafeExistingWikiFile, assertValidOwner, ensureWikiCategoryDir, normalizeSlug, wikiPath, writeSafeWikiFile } from "./paths.js";

const FRONTMATTER_PREFIX = "---\ncodexclawWiki: v1\nmeta: ";
const FRONTMATTER_SUFFIX = "\n---\n\n";

export function writeWikiPage(config: WikiConfig, meta: WikiPageMeta, body: string): WikiPage {
  assertValidOwner(meta.visibility, meta.ownerUserKey);
  const slug = normalizeSlug(meta.slug);
  ensureWikiCategoryDir(config, "pages");
  const pagePath = wikiPath(config, "pages", `${slug}.md`);
  writeSafeWikiFile(pagePath, `${FRONTMATTER_PREFIX}${JSON.stringify({ ...meta, slug })}${FRONTMATTER_SUFFIX}${body.trim()}\n`);
  return { path: pagePath, meta: { ...meta, slug }, body: body.trim() };
}

export function readWikiPage(path: string): WikiPage {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith(FRONTMATTER_PREFIX)) throw new Error(`Wiki page is missing codexclaw frontmatter: ${path}`);
  const afterPrefix = text.slice(FRONTMATTER_PREFIX.length);
  const end = afterPrefix.indexOf(FRONTMATTER_SUFFIX);
  if (end === -1) throw new Error(`Wiki page has malformed frontmatter: ${path}`);
  const meta = JSON.parse(afterPrefix.slice(0, end)) as WikiPageMeta;
  assertValidOwner(meta.visibility, meta.ownerUserKey);
  return {
    path,
    meta,
    body: afterPrefix.slice(end + FRONTMATTER_SUFFIX.length)
  };
}

export function listWikiPages(config: WikiConfig): WikiPage[] {
  const pagesDir = join(config.wikiRoot, "pages");
  if (!existsSync(pagesDir)) return [];
  assertSafeExistingWikiCategoryDir(config, "pages");
  try {
    return readdirSync(pagesDir)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map((file) => {
        const pagePath = join(pagesDir, file);
        assertSafeExistingWikiFile(pagePath, pagesDir, "wiki page");
        return readWikiPage(pagePath);
      });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function writeIngestManifest(config: WikiConfig, manifest: WikiIngestManifest): string {
  assertValidOwner(manifest.visibility, manifest.ownerUserKey);
  ensureWikiCategoryDir(config, "manifests");
  const manifestPath = wikiPath(config, "manifests", `${manifest.pageSlug}-${manifest.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeSafeWikiFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

export function pageLinkTarget(linkText: string): string {
  return `${normalizeSlug(basename(linkText, ".md"))}.md`;
}
