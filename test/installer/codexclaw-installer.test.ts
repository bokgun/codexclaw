import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const installer = join(repoRoot, "codexclaw.sh");

describe("codexclaw.sh installer", () => {
  test("dry-run prints safe defaults and writes nothing", async () => {
    const root = fixture();
    const envFile = join(root, ".env");
    const result = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      envFile,
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--channel",
      "none"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mode: dry-run");
    expect(result.stdout).toContain("CODEXCLAW_CODEX_WS=ws://127.0.0.1:4500");
    expect(result.stdout).toContain("CODEXCLAW_CODEX_LISTEN=ws://127.0.0.1:4500");
    expect(result.stdout).toContain("bun run cli");
    expect(existsSync(envFile)).toBe(false);
  });

  test("aligns custom local codex ws with the app-server listen URL", async () => {
    const root = fixture();
    const result = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--codex-ws",
      "ws://127.0.0.1:4600",
      "--channel",
      "none"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CODEXCLAW_CODEX_WS=ws://127.0.0.1:4600");
    expect(result.stdout).toContain("CODEXCLAW_CODEX_LISTEN=ws://127.0.0.1:4600");
  });

  test("dry-run accepts custom workspace, custom state, scheduler, and wiki", async () => {
    const root = fixture();
    const workspace = join(root, "project");
    const state = join(root, "outside-state");
    const result = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      workspace,
      "--state-dir",
      state,
      "--scheduler-enabled",
      "true",
      "--wiki-enabled",
      "true",
      "--channel",
      "cli"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`CODEXCLAW_WORKSPACE_ROOT=${workspace}`);
    expect(result.stdout).toContain(`CODEXCLAW_STATE_DIR=${state}`);
    expect(result.stdout).toContain("CODEXCLAW_SCHEDULER_ENABLED=true");
    expect(result.stdout).toContain("CODEXCLAW_WIKI_ENABLED=true");
  });

  test("rejects workspace-internal state outside local_dev opt-in", async () => {
    const root = fixture();
    const workspace = join(root, "workspace");
    const result = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      workspace,
      "--state-dir",
      join(workspace, ".codexclaw"),
      "--channel",
      "none"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CODEXCLAW_STATE_DIR must stay outside");
  });

  test("allows workspace-internal state only with local_dev explicit opt-in", async () => {
    const root = fixture();
    const workspace = join(root, "workspace");
    const result = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      workspace,
      "--state-dir",
      join(workspace, ".codexclaw"),
      "--deployment-mode",
      "local_dev",
      "--allow-workspace-internal-state",
      "true",
      "--channel",
      "none"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CODEXCLAW_DEPLOYMENT_MODE=local_dev");
    expect(result.stdout).toContain("CODEXCLAW_ALLOW_WORKSPACE_INTERNAL_STATE=true");
  });

  test("rejects unsafe non-loopback ws URLs", async () => {
    const root = fixture();
    const result = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--codex-ws",
      "ws://example.com:4500",
      "--deployment-mode",
      "reverse_proxy_wss",
      "--channel",
      "none"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("wss:// in reverse_proxy_wss mode");
  });

  test("requires Telegram allowlist unless local_dev allow-all is explicit", async () => {
    const root = fixture();
    const tokenFile = join(root, "telegram-token");
    writeFileSync(tokenFile, "12345:secret-token\n", { mode: 0o600 });
    const rejected = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--channel",
      "telegram",
      "--telegram-bot-token-file",
      tokenFile
    ]);

    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS is required");

    const accepted = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--deployment-mode",
      "local_dev",
      "--channel",
      "telegram",
      "--telegram-bot-token-file",
      tokenFile,
      "--telegram-allow-all-users-for-local-dev",
      "true"
    ]);

    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain("CODEXCLAW_TELEGRAM_BOT_TOKEN=[redacted]");
    expect(accepted.stdout).not.toContain("secret-token");
  });

  test("rejects malformed channel identity values", async () => {
    const root = fixture();
    const tokenFile = join(root, "telegram-token");
    writeFileSync(tokenFile, "12345:secret-token\n", { mode: 0o600 });
    const telegram = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--channel",
      "telegram",
      "--telegram-bot-token-file",
      tokenFile,
      "--telegram-allowed-user-ids",
      "not-a-number"
    ]);

    expect(telegram.exitCode).toBe(1);
    expect(telegram.stderr).toContain("must contain numeric Telegram user ids");

    const discordTokenFile = join(root, "discord-token");
    const discordPublicKeyFile = join(root, "discord-public-key");
    writeFileSync(discordTokenFile, "discord-secret\n", { mode: 0o600 });
    writeFileSync(discordPublicKeyFile, "bad-key\n", { mode: 0o600 });
    const discord = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--channel",
      "discord",
      "--discord-bot-token-file",
      discordTokenFile,
      "--discord-application-id",
      "not-a-snowflake",
      "--discord-public-key-file",
      discordPublicKeyFile,
      "--discord-allowed-user-ids",
      "42"
    ]);

    expect(discord.exitCode).toBe(1);
    expect(discord.stderr).toContain("CODEXCLAW_DISCORD_APPLICATION_ID must be a Discord snowflake");
  });

  test("rejects Telegram allow-all outside local_dev", async () => {
    const root = fixture();
    const tokenFile = join(root, "telegram-token");
    writeFileSync(tokenFile, "12345:secret-token\n", { mode: 0o600 });
    const result = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--channel",
      "telegram",
      "--telegram-bot-token-file",
      tokenFile,
      "--telegram-allow-all-users-for-local-dev",
      "true"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires local_dev deployment mode");
  });

  test("rejects local-dev allow-all with non-loopback Codex endpoints", async () => {
    const root = fixture();
    const tokenFile = join(root, "telegram-token");
    writeFileSync(tokenFile, "12345:secret-token\n", { mode: 0o600 });
    const result = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--deployment-mode",
      "local_dev",
      "--codex-ws",
      "wss://codex.example.com",
      "--channel",
      "telegram",
      "--telegram-bot-token-file",
      tokenFile,
      "--telegram-allow-all-users-for-local-dev",
      "true"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CODEXCLAW_CODEX_WS must point at loopback in local_dev mode");
  });

  test("requires Discord allowlist unless local_dev allow-all is explicit and redacts secrets", async () => {
    const root = fixture();
    const tokenFile = join(root, "discord-token");
    const publicKeyFile = join(root, "discord-public-key");
    writeFileSync(tokenFile, "discord-secret\n", { mode: 0o600 });
    writeFileSync(publicKeyFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
    const rejected = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--channel",
      "discord",
      "--discord-bot-token-file",
      tokenFile,
      "--discord-application-id",
      "123456",
      "--discord-public-key-file",
      publicKeyFile
    ]);

    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("CODEXCLAW_DISCORD_ALLOWED_USER_IDS is required");

    const accepted = await runInstaller(root, [
      "--dry-run",
      "--env-file",
      join(root, ".env"),
      "--workspace-root",
      join(root, "workspace"),
      "--state-dir",
      join(root, "state"),
      "--deployment-mode",
      "local_dev",
      "--channel",
      "discord",
      "--discord-bot-token-file",
      tokenFile,
      "--discord-application-id",
      "123456",
      "--discord-public-key-file",
      publicKeyFile,
      "--discord-allow-all-users-for-local-dev",
      "true"
    ]);

    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain("CODEXCLAW_DISCORD_BOT_TOKEN=[redacted]");
    expect(accepted.stdout).toContain("CODEXCLAW_DISCORD_PUBLIC_KEY=[redacted]");
    expect(accepted.stdout).not.toContain("discord-secret");
    expect(accepted.stdout).not.toContain("a".repeat(64));
  });

  test("interactive write preserves unrelated keys and private permissions", async () => {
    const root = fixture();
    const envFile = join(root, ".env");
    writeFileSync(envFile, "UNRELATED_KEY=keep\nCODEXCLAW_WIKI_ENABLED=true\n", { mode: 0o644 });

    const result = await runInstaller(
      root,
      [
        "--env-file",
        envFile,
        "--workspace-root",
        join(root, "workspace"),
        "--state-dir",
        join(root, "state"),
        "--channel",
        "none",
        "--yes"
      ],
      "unused\n"
    );

    expect(result.exitCode).toBe(0);
    const written = readFileSync(envFile, "utf8");
    expect(written).toContain("UNRELATED_KEY=keep");
    expect(written).toContain("CODEXCLAW_WIKI_ENABLED=false");
    expect(written).toContain(`CODEXCLAW_STATE_DIR=${join(root, "state")}`);
    expect(statSync(envFile).mode & 0o077).toBe(0);
  });

  test("interactive write refuses secret overwrite without confirmation", async () => {
    const root = fixture();
    const envFile = join(root, ".env");
    const tokenFile = join(root, "telegram-token");
    writeFileSync(tokenFile, "new-secret\n", { mode: 0o600 });
    writeFileSync(envFile, "CODEXCLAW_TELEGRAM_BOT_TOKEN=old-secret\nUNRELATED_KEY=keep\n", { mode: 0o600 });

    const refused = await runInstaller(
      root,
      [
        "--env-file",
        envFile,
        "--workspace-root",
        join(root, "workspace"),
        "--state-dir",
        join(root, "state"),
        "--channel",
        "telegram",
        "--telegram-bot-token-file",
        tokenFile,
        "--telegram-allowed-user-ids",
        "42"
      ],
      "n\n"
    );

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("refusing to overwrite existing secret");
    expect(readFileSync(envFile, "utf8")).toContain("CODEXCLAW_TELEGRAM_BOT_TOKEN=old-secret");

    const replaced = await runInstaller(
      root,
      [
        "--env-file",
        envFile,
        "--workspace-root",
        join(root, "workspace"),
        "--state-dir",
        join(root, "state"),
        "--channel",
        "telegram",
        "--telegram-bot-token-file",
        tokenFile,
        "--telegram-allowed-user-ids",
        "42"
      ],
      "y\ny\n"
    );

    expect(replaced.exitCode).toBe(0);
    const written = readFileSync(envFile, "utf8");
    expect(written).toContain("CODEXCLAW_TELEGRAM_BOT_TOKEN=new-secret");
    expect(written).toContain("UNRELATED_KEY=keep");
  });

  test("writes secret env files privately even with a permissive process umask", async () => {
    const root = fixture();
    const envFile = join(root, ".env");
    const tokenFile = join(root, "telegram-token");
    writeFileSync(tokenFile, "new-secret\n", { mode: 0o600 });
    const previousUmask = process.umask(0o022);
    try {
      const result = await runInstaller(root, [
        "--env-file",
        envFile,
        "--workspace-root",
        join(root, "workspace"),
        "--state-dir",
        join(root, "state"),
        "--channel",
        "telegram",
        "--telegram-bot-token-file",
        tokenFile,
        "--telegram-allowed-user-ids",
        "42",
        "--yes"
      ]);

      expect(result.exitCode).toBe(0);
      expect(statSync(envFile).mode & 0o077).toBe(0);
      expect(readFileSync(envFile, "utf8")).toContain("CODEXCLAW_TELEGRAM_BOT_TOKEN=new-secret");
    } finally {
      process.umask(previousUmask);
    }
  });
});

function fixture(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "codexclaw-installer-")));
}

async function runInstaller(cwd: string, args: string[], stdin = ""): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = spawnSync("bash", [installer, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: dirname(cwd)
    },
    input: stdin,
    encoding: "utf8"
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}
