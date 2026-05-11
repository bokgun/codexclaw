import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileDeliveryCollector,
  hasTelegramFileDeliveryIntent,
  validateCandidatePaths,
  validateLocalDocumentForUpload
} from "../../src/runtime/file-delivery.js";
import type { FileDeliveryPolicy } from "../../src/runtime/types.js";

describe("file delivery policy", () => {
  test("requires explicit Telegram delivery intent", () => {
    expect(hasTelegramFileDeliveryIntent("The report is at ./out/report.pdf")).toBe(false);
    expect(hasTelegramFileDeliveryIntent("Please send the generated report file when done")).toBe(true);
    expect(hasTelegramFileDeliveryIntent("upload this generated csv document")).toBe(true);
    expect(hasTelegramFileDeliveryIntent("생성한 보고서 파일을 텔레그램으로 보내줘")).toBe(true);
    expect(hasTelegramFileDeliveryIntent("보고서 파일은 ./out/report.pdf 에 있어")).toBe(false);
  });

  test("validates roots, duplicates, denied paths, size limits, and missing files", () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-delivery-"));
    mkdirSync(join(root, "out"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".ssh"));
    writeFileSync(join(root, "out/report.pdf"), "pdf");
    writeFileSync(join(root, "out/large.pdf"), "123456");
    writeFileSync(join(root, ".git/config"), "secret");
    writeFileSync(join(root, ".env"), "secret");
    writeFileSync(join(root, ".ssh/id_ed25519"), "secret");

    const result = validateCandidatePaths(
      [
        { rawText: "out/report.pdf", source: "runtime_file_metadata" },
        { rawText: "out/report.pdf", source: "runtime_file_metadata" },
        { rawText: "out/missing.pdf", source: "runtime_file_metadata" },
        { rawText: "out/large.pdf", source: "runtime_file_metadata" },
        { rawText: ".git/config", source: "runtime_file_metadata" },
        { rawText: ".env", source: "runtime_file_metadata" },
        { rawText: ".ssh/id_ed25519", source: "runtime_file_metadata" },
        { rawText: "/etc/hosts", source: "runtime_file_metadata" }
      ],
      policy(root, { maxFileBytes: 4 })
    );

    expect(result.accepted.map((document) => document.displayName)).toEqual(["report.pdf"]);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      "duplicate",
      "missing",
      "too_large",
      "denied_path",
      "denied_path",
      "denied_path",
      "outside_allowed_roots"
    ]);
  });

  test("rejects symlink escapes and revalidates just before upload", () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-delivery-"));
    const outside = mkdtempSync(join(tmpdir(), "codexclaw-outside-"));
    writeFileSync(join(outside, "outside.pdf"), "outside");
    symlinkSync(join(outside, "outside.pdf"), join(root, "linked.pdf"));

    const result = validateCandidatePaths([{ rawText: "linked.pdf", source: "runtime_file_metadata" }], policy(root));

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toBe("symlink_escape");
    expect(() => validateLocalDocumentForUpload(join(root, "linked.pdf"), policy(root))).toThrow("symlink_escape");
  });

  test("enforces max files per turn", () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-delivery-"));
    writeFileSync(join(root, "a.pdf"), "a");
    writeFileSync(join(root, "b.pdf"), "b");

    const result = validateCandidatePaths(
      [
        { rawText: "a.pdf", source: "runtime_file_metadata" },
        { rawText: "b.pdf", source: "runtime_file_metadata" }
      ],
      policy(root, { maxFilesPerTurn: 1 })
    );

    expect(result.accepted.map((document) => document.displayName)).toEqual(["a.pdf"]);
    expect(result.rejected[0]?.reason).toBe("limit_exceeded");
  });

  test("bounds collected candidates before validation", () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-delivery-"));
    const collector = new FileDeliveryCollector();
    collector.bindThread("thread-1", { enabled: true, userKey: "telegram:1", startedAtMs: 0 });

    collector.collectRuntimeFilePaths("thread-1", "turn-1", ["a.pdf", "b.pdf", "c.pdf"], policy(root, { maxCandidatesPerTurn: 1 }));
    const result = collector.finishTurn("thread-1", "turn-1", policy(root, { maxCandidatesPerTurn: 1 }));

    expect(result?.rejected.map((item) => item.reason)).toEqual(["missing", "limit_exceeded"]);
  });
});

function policy(root: string, overrides: Partial<FileDeliveryPolicy> = {}): FileDeliveryPolicy {
  return {
    enabled: true,
    allowedRoots: [root],
    deniedRoots: [join(root, ".codexclaw"), join(root, ".codex"), join(root, ".git")],
    deniedSegments: [".git", ".codex", ".codexclaw"],
    maxFileBytes: 1024,
    maxFilesPerTurn: 3,
    maxCandidatesPerTurn: 30,
    workspaceRoot: root,
    ...overrides
  };
}
