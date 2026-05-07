import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CODEX_METHODS, CodexRuntimeClient } from "../../src/codex/runtime-client.js";
import { CodexSkillInspector, normalizeCodexSkillsResponse } from "../../src/skills/codex-skills.js";
import { createSkillInspectionService } from "../../src/skills/index.js";
import { listHostSkills } from "../../src/skills/host-registry.js";
import type { JsonValue, RpcNotification, RpcServerRequest } from "../../src/codex/ws-client.js";
import type { SkillsListResponse } from "../../src/codex/runtime-client.js";

describe("skills inspection", () => {
  test("CodexRuntimeClient calls skills/list with bounded workspace params and invalidates on notification", async () => {
    const transport = new MockTransport();
    const client = new CodexRuntimeClient(transport as never);
    const events: string[] = [];
    client.onEvent((event) => events.push(event.kind));

    await client.listSkills({ cwds: ["/workspace"], forceReload: true });
    transport.emitNotification({ method: "skills/changed", params: {} });

    expect(transport.requests).toEqual([{ method: CODEX_METHODS.skillsList, params: { cwds: ["/workspace"], forceReload: true } }]);
    expect(transport.requests.map((request) => request.method)).not.toContain("skills/config/write");
    expect(events).toContain("skills_changed");
  });

  test("normalizes Codex skills without dependency commands, urls, prompts, or private paths", () => {
    const workspaceRoot = "/workspace/project";
    const normalized = normalizeCodexSkillsResponse(skillResponse(workspaceRoot, "/private/secret/skill/SKILL.md"), {
      workspaceRoot,
      maxErrorChars: 180
    });

    expect(normalized.summaries[0]).toMatchObject({
      family: "codex",
      name: "Code Review",
      scope: "repo",
      enabled: true,
      sourceLabel: "skills/[at]everyone/SKILL.md"
    });
    const rendered = JSON.stringify(normalized);
    expect(rendered).not.toContain("npm install secret");
    expect(rendered).not.toContain("https://secret.example");
    expect(rendered).not.toContain("https://leak.example");
    expect(rendered).not.toContain("ssh://secret.example");
    expect(rendered).not.toContain("default prompt secret");
    expect(rendered).not.toContain("/private/secret");
    expect(rendered).not.toContain("/private/tmp/token");
    expect(rendered).not.toContain("/opt/secret/file");
    expect(rendered).not.toContain("C:\\Users\\name\\secret");
    expect(rendered).not.toContain("@everyone");
    expect(rendered).toContain("skill metadata error details omitted");
    expect(rendered).toContain("[url redacted]");
    expect(rendered).toContain("[at]everyone");
  });

  test("normalizes malformed Codex skill scope before channel rendering", () => {
    const workspaceRoot = "/workspace/project";
    const response = skillResponse(workspaceRoot, "/private/secret/skill/SKILL.md");
    response.data[0]!.skills[0]!.scope = "@everyone" as never;
    response.data[0]!.skills[0]!.path = "metadata=/private/secret/SKILL.md";
    response.data[0]!.cwd = "cwd=/private/secret";
    response.data[0]!.errors = [{ path: "error=/private/secret/SKILL.md", message: "bad" }];

    const normalized = normalizeCodexSkillsResponse(response, { workspaceRoot });
    const rendered = JSON.stringify(normalized);

    expect(normalized.summaries[0]!.scope).toBe("unknown");
    expect(rendered).not.toContain("@everyone");
    expect(rendered).not.toContain("/private/secret");
  });

  test("caches skills in process memory and invalidates on demand", async () => {
    const codex = new MockCodex("/workspace/project");
    const inspector = new CodexSkillInspector(codex, { workspaceRoot: "/workspace/project" });

    await inspector.list();
    await inspector.list();
    inspector.invalidate();
    await inspector.list();

    expect(codex.calls).toEqual([
      { cwds: ["/workspace/project"], forceReload: true },
      { cwds: ["/workspace/project"], forceReload: true }
    ]);
  });

  test("lists host skills as metadata-only entries including disabled channels and installer placeholder", () => {
    const host = listHostSkills({ activeChannel: "cli", schedulerEnabled: false, wikiEnabled: true });

    expect(host.find((skill) => skill.name === "telegram")).toMatchObject({
      family: "host",
      scope: "channel",
      enabled: false,
      boundary: "metadata_only"
    });
    expect(host.find((skill) => skill.name === "skill-installer")).toMatchObject({ enabled: false, scope: "installer" });
    expect(JSON.stringify(host)).not.toContain("token");
  });

  test("renders a sorted bounded unified list and fails closed when Codex list fails", async () => {
    const codex = new MockCodex("/workspace/project");
    codex.fail = true;
    const service = createSkillInspectionService(codex, {
      workspaceRoot: "/workspace/project",
      activeChannel: "cli",
      outputPolicy: { maxItems: 3, maxOutputChars: 700 }
    });

    const output = await service.renderSkillList();

    expect(output).toStartWith("Skills (read-only)");
    expect(output).toContain("[host/channel/enabled] cli");
    expect(output).toContain("Codex skills unavailable");
    expect(output).not.toContain("/workspace/project");
    expect(output.length).toBeLessThanOrEqual(700);
  });
});

class MockCodex {
  calls: Array<{ cwds: string[]; forceReload?: boolean }> = [];
  fail = false;

  constructor(private readonly workspaceRoot: string) {}

  async listSkills(params: { cwds: string[]; forceReload?: boolean }): Promise<SkillsListResponse> {
    this.calls.push(params);
    if (this.fail) throw new Error(`failed at ${this.workspaceRoot}/private`);
    return skillResponse(this.workspaceRoot, join(this.workspaceRoot, "skills", "review", "SKILL.md"));
  }
}

class MockTransport {
  requests: Array<{ method: string; params: JsonValue | undefined }> = [];
  private notificationHandlers = new Set<(notification: RpcNotification) => void>();

  async request(method: string, params?: JsonValue): Promise<JsonValue> {
    this.requests.push({ method, params });
    if (method === CODEX_METHODS.skillsList) return { data: [] };
    return {};
  }

  emitNotification(notification: RpcNotification): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }

  onNotification(handler: (notification: RpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(_handler: (request: RpcServerRequest) => void): () => void {
    return () => undefined;
  }

  onClose(): () => void {
    return () => undefined;
  }

  respond(): void {}
  respondError(): void {}
  close(): void {}
}

function skillResponse(workspaceRoot: string, errorPath: string): SkillsListResponse {
  return {
    data: [
      {
        cwd: workspaceRoot,
        skills: [
          {
            name: "review",
            description: "Review code safely",
            shortDescription: "Review code",
            interface: {
              displayName: "Code Review",
              shortDescription: "Review @everyone code changes with ssh://secret.example/token cache=/private/tmp/token list=[/opt/secret/file] path=C:\\Users\\name\\secret",
              defaultPrompt: "default prompt secret"
            },
            dependencies: {
              tools: [
                {
                  type: "command",
                  value: "node",
                  command: "npm install secret",
                  url: "https://secret.example"
                }
              ]
            },
            path: join(workspaceRoot, "skills", "@everyone", "SKILL.md"),
            scope: "repo",
            enabled: true
          }
        ],
        errors: [
          {
            path: errorPath,
            message: `very long parse error in ${errorPath} with @everyone and https://leak.example/secret`
          }
        ]
      }
    ]
  };
}
