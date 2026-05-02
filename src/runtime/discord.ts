import { createDiscordChannelAdapter } from "../channel/discord.js";
import { getDiscordConfig, getSchedulerConfig } from "../config/env.js";
import { HostRuntime } from "./host.js";

const config = getDiscordConfig();
const scheduler = getSchedulerConfig();
const runtime = new HostRuntime({
  channel: createDiscordChannelAdapter({ config, startInteractionServer: true, startGateway: true }),
  approvalModifyTtlMs: config.modifyTimeoutMs,
  branchSuggestions: {},
  scheduler
});

try {
  await runtime.start();
} finally {
  runtime.close();
}
