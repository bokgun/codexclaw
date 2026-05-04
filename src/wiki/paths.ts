import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WikiConfig, WikiSourceKind, WikiSourceRef, NormalizedWikiSource } from "./types.js";

const DENIED_CODEX_SEGMENTS = [
  `${sep}.codex${sep}sessions${sep}`,
  `${sep}.codex${sep}session${sep}`,
  `${sep}.codex${sep}rollouts${sep}`,
  `${sep}.codex${sep}rollout${sep}`,
  `${sep}codex${sep}sessions${sep}`,
  `${sep}codex${sep}session${sep}`,
  `${sep}codex${sep}rollouts${sep}`,
  `${sep}codex${sep}rollout${sep}`
];

export function assertValidOwner(visibility: "project_public" | "user_private", ownerUserKey?: string): void {
  if (visibility === "project_public" && ownerUserKey) throw new Error("project_public wiki artifacts must not have an owner");
  if (visibility === "user_private" && !ownerUserKey?.trim()) throw new Error("user_private wiki artifacts require ownerUserKey");
}

export function normalizeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new Error("Wiki slug must contain at least one alphanumeric character");
  return slug;
}

export function wikiPath(config: WikiConfig, category: "pages" | "manifests" | "lint", fileName: string): string {
  const safeName = basename(fileName);
  if (safeName !== fileName || safeName.includes("..")) throw new Error("Unsafe wiki file name");
  return assertWithinRoot(resolve(config.wikiRoot, category, safeName), config.wikiRoot, "wiki path");
}

export function ensureWikiCategoryDir(config: WikiConfig, category: "pages" | "manifests" | "lint"): string {
  mkdirSync(config.wikiRoot, { recursive: true });
  assertNotSymlink(config.wikiRoot, "wiki root");
  const realRoot = realpathSync(config.wikiRoot);

  const dir = join(config.wikiRoot, category);
  mkdirSync(dir, { recursive: true });
  assertNotSymlink(dir, `wiki ${category} directory`);
  const realDir = realpathSync(dir);
  const rel = relative(realRoot, realDir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return dir;
  throw new Error(`Unsafe wiki ${category} directory: path escapes root`);
}

export function assertSafeExistingWikiCategoryDir(config: WikiConfig, category: "pages" | "manifests" | "lint"): string {
  assertNotSymlink(config.wikiRoot, "wiki root");
  const realRoot = realpathSync(config.wikiRoot);
  const dir = join(config.wikiRoot, category);
  assertNotSymlink(dir, `wiki ${category} directory`);
  const realDir = realpathSync(dir);
  const rel = relative(realRoot, realDir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return dir;
  throw new Error(`Unsafe wiki ${category} directory: path escapes root`);
}

export function assertSafeWikiFileTarget(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error("Unsafe wiki file target: symlinks are not allowed");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export function assertSafeExistingWikiFile(path: string, root: string, label: string): void {
  const link = lstatSync(path);
  if (link.isSymbolicLink()) throw new Error(`Unsafe ${label}: symlinks are not allowed`);
  const realPath = realpathSync(path);
  const realRoot = realpathSync(root);
  const rel = relative(realRoot, realPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`Unsafe ${label}: path escapes root`);
}

export function writeSafeWikiFile(path: string, content: string): void {
  assertSafeWikiFileTarget(path);
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(tempPath, "wx", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
  } catch (error) {
    closeSync(fd);
    unlinkSync(tempPath);
    throw error;
  }
  closeSync(fd);
  renameSync(tempPath, path);
}

export function assertWithinRoot(path: string, root: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return resolvedPath;
  throw new Error(`Unsafe ${label}: path escapes root`);
}

export function rejectCodexOwnedPath(path: string): void {
  const padded = `${sep}${resolve(path).split(/[\\/]+/).join(sep)}${sep}`;
  if (DENIED_CODEX_SEGMENTS.some((segment) => padded.includes(segment))) {
    throw new Error("Codex rollout/session paths are not valid wiki sources");
  }
}

export function normalizeSourcePath(config: WikiConfig, inputPath: string, kind: WikiSourceKind, now = new Date()): NormalizedWikiSource {
  if (kind !== "repo_file" && kind !== "user_note") throw new Error(`Unsupported file-backed wiki source kind: ${kind}`);
  const requested = resolve(inputPath);
  rejectCodexOwnedPath(requested);
  if (!existsSync(requested)) throw new Error(`Wiki source does not exist: ${inputPath}`);

  const link = lstatSync(requested);
  const real = realpathSync(requested);
  rejectCodexOwnedPath(real);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`Wiki source is not a regular file: ${inputPath}`);
  if (stat.size > config.maxSourceBytes) throw new Error(`Wiki source exceeds maxSourceBytes: ${inputPath}`);
  if (!isWithinAllowedRoot(real, config.allowedSourceRoots)) throw new Error(`Wiki source is outside allowed roots: ${inputPath}`);

  const displayPath = displaySourcePath(real, config.allowedSourceRoots);
  return {
    size: stat.size,
    ref: {
      kind,
      displayPath: link.isSymbolicLink() ? `${displayPath} (symlink target)` : displayPath,
      resolvedPath: real,
      observedAt: now.toISOString()
    }
  };
}

export function isWithinAllowedRoot(path: string, allowedRoots: readonly string[]): boolean {
  const realPath = realpathSync(path);
  return allowedRoots.some((root) => {
    const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
    const rel = relative(realRoot, realPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function displaySourcePath(path: string, allowedRoots: readonly string[]): string {
  for (const root of allowedRoots) {
    const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
    const rel = relative(realRoot, path);
    if (rel === "") return basename(realRoot);
    if (rel && !rel.startsWith("..") && !rel.includes(`..${sep}`)) return rel;
  }
  return path;
}

function assertNotSymlink(path: string, label: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Unsafe ${label}: symlinks are not allowed`);
}
