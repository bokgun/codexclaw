import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("start-codex-app-server helper", () => {
  test("preserves custom CODEX_HOME when plugin supervision is disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-start-codex-home-test-"));
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    const codexHome = join(root, "custom-codex-home");
    writeFileSync(join(root, ".env"), `CODEXCLAW_WORKSPACE_ROOT=${workspace}\nCODEXCLAW_STATE_DIR=${state}\n`);
    mkdirSync(bin, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash
env | sort
`,
      { mode: 0o755 }
    );

    const result = spawnSync("bash", [join(process.cwd(), "scripts/start-codex-app-server.sh")], {
      cwd: root,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: root,
        CODEX_HOME: codexHome
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`CODEX_HOME=${codexHome}`);
  });

  test("sanitizes app-server environment when plugin supervision is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-start-codex-test-"));
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    const managedHome = join(state, "codex-home");
    const envFile = join(root, ".env");
    writeFileSync(envFile, `CODEXCLAW_WORKSPACE_ROOT=${workspace}\nCODEXCLAW_STATE_DIR=${state}\nCODEXCLAW_PLUGIN_SUPERVISION_ENABLED=true\n`);
    mkdirSync(bin, { recursive: true });
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(join(managedHome, "auth.json"), "{}\n", { mode: 0o600 });
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash
env | sort
`,
      { mode: 0o755 }
    );

    const result = spawnSync("bash", [join(process.cwd(), "scripts/start-codex-app-server.sh")], {
      cwd: root,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: root,
        OPENAI_API_KEY: "sk-1234567890abcdefghijkl",
        GITHUB_TOKEN: "ghp_1234567890abcdefghijkl",
        CODEXCLAW_TELEGRAM_BOT_TOKEN: "telegram-secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock"
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`CODEX_HOME=${join(realpathSync(state), "codex-home")}`);
    expect(result.stdout).toContain("PATH=");
    expect(result.stdout).not.toContain("OPENAI_API_KEY");
    expect(result.stdout).not.toContain("GITHUB_TOKEN");
    expect(result.stdout).not.toContain("CODEXCLAW_TELEGRAM_BOT_TOKEN");
    expect(result.stdout).not.toContain("SSH_AUTH_SOCK");
  });

  test("accepts yes as a plugin supervision boolean", () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-start-codex-yes-test-"));
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    const managedHome = join(state, "codex-home");
    writeFileSync(join(root, ".env"), `CODEXCLAW_WORKSPACE_ROOT=${workspace}\nCODEXCLAW_STATE_DIR=${state}\nCODEXCLAW_PLUGIN_SUPERVISION_ENABLED=yes\n`);
    mkdirSync(bin, { recursive: true });
    mkdirSync(managedHome, { recursive: true });
    writeFileSync(join(managedHome, "auth.json"), "{}\n", { mode: 0o600 });
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash
env | sort
`,
      { mode: 0o755 }
    );

    const result = spawnSync("bash", [join(process.cwd(), "scripts/start-codex-app-server.sh")], {
      cwd: root,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: root
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`CODEX_HOME=${join(realpathSync(state), "codex-home")}`);
  });

  test("requires managed CODEX_HOME auth before plugin-supervised startup", () => {
    const root = mkdtempSync(join(tmpdir(), "codexclaw-start-codex-auth-test-"));
    const workspace = join(root, "workspace");
    const state = join(root, "state");
    writeFileSync(join(root, ".env"), `CODEXCLAW_WORKSPACE_ROOT=${workspace}\nCODEXCLAW_STATE_DIR=${state}\nCODEXCLAW_PLUGIN_SUPERVISION_ENABLED=true\n`);

    const result = spawnSync("bash", [join(process.cwd(), "scripts/start-codex-app-server.sh")], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("codex login --device-auth");
  });
});
