import { createTelegramChannelAdapter } from "../channel/telegram.js";
import { getCodexConnectionConfig, getTelegramConfig } from "../config/env.js";
import { HostRuntime } from "./host.js";

getCodexConnectionConfig();
const config = getTelegramConfig();
const runtime = new HostRuntime({
  channel: createTelegramChannelAdapter({ config }),
  approvalModifyTtlMs: config.modifyTimeoutMs,
  branchSuggestions: {}
});

try {
  await runtime.start();
} finally {
  runtime.close();
}
