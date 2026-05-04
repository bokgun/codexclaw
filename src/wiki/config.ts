import { resolve } from "node:path";
import type { WikiConfig } from "./types.js";

export interface WikiConfigInput {
  enabled?: boolean;
  wikiRoot?: string;
  allowedSourceRoots?: readonly string[];
  maxSourceBytes?: number;
  maxQueryResults?: number;
  maxExcerptChars?: number;
}

export function createWikiConfig(input: WikiConfigInput = {}, cwd = process.cwd()): WikiConfig {
  const enabled = input.enabled ?? false;
  const wikiRoot = resolve(cwd, input.wikiRoot ?? "wiki");
  const allowedSourceRoots = (input.allowedSourceRoots ?? [cwd]).map((root) => resolve(cwd, root));
  const maxSourceBytes = boundedInteger(input.maxSourceBytes ?? 256 * 1024, "maxSourceBytes", 1, 5 * 1024 * 1024);
  const maxQueryResults = boundedInteger(input.maxQueryResults ?? 5, "maxQueryResults", 1, 50);
  const maxExcerptChars = boundedInteger(input.maxExcerptChars ?? 500, "maxExcerptChars", 80, 5_000);

  if (allowedSourceRoots.length === 0) throw new Error("Wiki allowedSourceRoots must contain at least one root");
  if (allowedSourceRoots.some((root) => root === wikiRoot || root.startsWith(`${wikiRoot}/`))) {
    throw new Error("Wiki source roots must not be inside the wiki root");
  }

  return {
    enabled,
    wikiRoot,
    allowedSourceRoots,
    maxSourceBytes,
    maxQueryResults,
    maxExcerptChars
  };
}

export function requireWikiEnabled(config: WikiConfig): void {
  if (!config.enabled) throw new Error("Wiki is disabled");
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Wiki ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
