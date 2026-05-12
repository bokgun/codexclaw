import { describe, expect, test } from "bun:test";
import {
  isSensitiveEnvName,
  validatePluginDescriptor,
  type PluginDescriptorV1,
  type PluginValidationDiagnostic
} from "../../src/plugins/index.js";

describe("plugin descriptor validation", () => {
  test("accepts a valid metadata-only MCP descriptor", () => {
    const result = validatePluginDescriptor(validDescriptor());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected descriptor to validate");

    expect(result.descriptor).toMatchObject({
      schemaVersion: 1,
      id: "opencandle",
      displayName: "OpenCandle",
      mcp: {
        serverName: "opencandle",
        command: "/usr/local/bin/bun",
        args: ["src/plugins/opencandle/server.ts"],
        env: [{ name: "OPENCANDLE_ROOT", required: true }]
      },
      security: {
        network: "declared",
        providers: ["alternative.me"],
        envAllowlist: ["OPENCANDLE_ROOT"],
        elicitation: "fail_closed"
      }
    });
    expect(result.summary).toEqual({
      id: "opencandle",
      displayName: "OpenCandle",
      version: "0.1.0",
      description: "Market metadata provider.",
      serverName: "opencandle",
      tools: [
        {
          name: "get_fear_greed",
          title: "Fear and Greed",
          description: "Return the current fear and greed index."
        }
      ],
      security: {
        network: "declared",
        providers: ["alternative.me"],
        envNames: ["OPENCANDLE_ROOT"],
        elicitation: "fail_closed"
      }
    });
    expect(JSON.stringify(result.summary)).not.toContain("/usr/local/bin/bun");
    expect(JSON.stringify(result.summary)).not.toContain("src/plugins/opencandle/server.ts");
  });

  test("fails closed for unknown schema versions and descriptor fields", () => {
    const result = validatePluginDescriptor({
      ...validDescriptor(),
      schemaVersion: 2,
      enabled: true,
      rawMcpOutput: "do not persist me"
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("invalid_schema_version");
    expect(paths(result)).toContain("$.enabled");
    expect(paths(result)).toContain("$.rawMcpOutput");
  });

  test("rejects unsafe ids, commands, shell command strings, and control-character args", () => {
    const result = validatePluginDescriptor({
      ...validDescriptor(),
      id: "../bad id",
      mcp: {
        serverName: "bad/server",
        command: "bun src/plugin.ts && rm -rf /",
        args: ["ok", "bad\narg"]
      }
    });

    expect(result.ok).toBe(false);
    expect(paths(result)).toContain("$.id");
    expect(paths(result)).toContain("$.mcp.serverName");
    expect(paths(result)).toContain("$.mcp.command");
    expect(paths(result)).toContain("$.mcp.args[1]");
  });

  test("rejects sensitive env names and undeclared allowlist entries", () => {
    const sensitiveNames = [
      "CODEXCLAW_TELEGRAM_BOT_TOKEN",
      "CODEXCLAW_DISCORD_BOT_TOKEN",
      "CODEXCLAW_CODEX_TOKEN_FILE",
      "CODEXCLAW_STATE_DIR",
      "CODEXCLAW_DB",
      "CODEX_HOME",
      "OPENAI_API_KEY",
      "MY_SECRET",
      "SERVICE_TOKEN",
      "USER_PASSWORD",
      "PRIVATE_KEY"
    ];

    for (const name of sensitiveNames) {
      expect(isSensitiveEnvName(name)).toBe(true);
      const result = validatePluginDescriptor({
        ...validDescriptor(),
        mcp: {
          ...validDescriptor().mcp,
          env: [{ name }]
        },
        security: {
          ...validDescriptor().security,
          envAllowlist: [name]
        }
      });
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("sensitive_env");
    }

    const undeclared = validatePluginDescriptor({
      ...validDescriptor(),
      security: {
        ...validDescriptor().security,
        envAllowlist: ["OPENCANDLE_ROOT", "UNDECLARED_ROOT"]
      }
    });
    expect(undeclared.ok).toBe(false);
    expect(paths(undeclared)).toContain("$.security.envAllowlist[1]");
  });

  test("validates network and provider metadata consistently", () => {
    const missingProvider = validatePluginDescriptor({
      ...validDescriptor(),
      security: { network: "declared", envAllowlist: ["OPENCANDLE_ROOT"] }
    });
    expect(missingProvider.ok).toBe(false);
    expect(paths(missingProvider)).toContain("$.security.providers");

    const providerWithoutNetwork = validatePluginDescriptor({
      ...validDescriptor(),
      security: { network: "none", providers: ["alternative.me"], envAllowlist: ["OPENCANDLE_ROOT"] }
    });
    expect(providerWithoutNetwork.ok).toBe(false);
    expect(paths(providerWithoutNetwork)).toContain("$.security.providers");

    const noNetworkNoProvider = validatePluginDescriptor({
      ...validDescriptor(),
      security: { network: "none", envAllowlist: ["OPENCANDLE_ROOT"] }
    });
    expect(noNetworkNoProvider.ok).toBe(true);
  });

  test("bounds display metadata and rejects raw tool payload-shaped fields", () => {
    const result = validatePluginDescriptor({
      ...validDescriptor(),
      displayName: ` OpenCandle ${"x".repeat(300)} `,
      tools: [
        {
          name: "get_fear_greed",
          title: "Fear and Greed",
          description: "safe",
          arguments: { symbol: "BTC" },
          output: "provider body"
        }
      ]
    });

    expect(result.ok).toBe(false);
    expect(paths(result)).toContain("$.tools[0].arguments");
    expect(paths(result)).toContain("$.tools[0].output");

    const bounded = validatePluginDescriptor({
      ...validDescriptor(),
      displayName: ` OpenCandle ${"x".repeat(300)} `
    });
    expect(bounded.ok).toBe(true);
    if (!bounded.ok) throw new Error("expected bounded descriptor");
    expect(bounded.summary.displayName.length).toBeLessThanOrEqual(120);
    expect(bounded.summary.displayName).toContain("[truncated]");
  });

  test("does not execute commands or require command paths to exist", () => {
    const descriptor = validDescriptor();
    const result = validatePluginDescriptor({
      ...descriptor,
      mcp: {
        ...descriptor.mcp,
        command: "/definitely/missing/codexclaw-plugin-command"
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected descriptor to validate");
    expect(result.descriptor.mcp.command).toBe("/definitely/missing/codexclaw-plugin-command");
  });
});

function validDescriptor(): PluginDescriptorV1 {
  return {
    schemaVersion: 1,
    id: "opencandle",
    displayName: "OpenCandle",
    version: "0.1.0",
    description: "Market metadata provider.",
    mcp: {
      serverName: "opencandle",
      command: "/usr/local/bin/bun",
      args: ["src/plugins/opencandle/server.ts"],
      env: [{ name: "OPENCANDLE_ROOT", required: true, description: "Local OpenCandle checkout." }]
    },
    tools: [
      {
        name: "get_fear_greed",
        title: "Fear and Greed",
        description: "Return the current fear and greed index."
      }
    ],
    security: {
      network: "declared",
      providers: ["alternative.me"],
      envAllowlist: ["OPENCANDLE_ROOT"]
    }
  };
}

function codes(result: ReturnType<typeof validatePluginDescriptor>): string[] {
  if (result.ok) return [];
  return result.diagnostics.map((item: PluginValidationDiagnostic) => item.code);
}

function paths(result: ReturnType<typeof validatePluginDescriptor>): string[] {
  if (result.ok) return [];
  return result.diagnostics.map((item: PluginValidationDiagnostic) => item.path);
}
