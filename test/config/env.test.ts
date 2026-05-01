import { afterEach, describe, expect, test } from "bun:test";
import { getTelegramConfig, redactTelegramSecrets } from "../../src/config/env.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("Telegram config", () => {
  test("requires a bot token and allowlisted numeric user ids", () => {
    delete process.env.CODEXCLAW_TELEGRAM_BOT_TOKEN;
    expect(() => getTelegramConfig()).toThrow("CODEXCLAW_TELEGRAM_BOT_TOKEN");

    process.env.CODEXCLAW_TELEGRAM_BOT_TOKEN = "123:secret";
    process.env.CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS = "42,not-a-number";
    expect(() => getTelegramConfig()).toThrow("numeric Telegram user ids");

    process.env.CODEXCLAW_TELEGRAM_ALLOWED_USER_IDS = "42, 43";
    const config = getTelegramConfig();
    expect(config.allowedUserIds).toEqual(["42", "43"]);
    expect(config.allowAllUsersForLocalDev).toBe(false);
  });

  test("redacts bot tokens in Telegram API errors", () => {
    expect(redactTelegramSecrets("https://api.telegram.org/bot123:secret/sendMessage failed", "123:secret")).toBe(
      "https://api.telegram.org/bot[telegram-bot-token]/sendMessage failed"
    );
    expect(redactTelegramSecrets("token 123:secret leaked", "123:secret")).toBe("token [telegram-bot-token] leaked");
  });
});
