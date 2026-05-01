import type { CodexWsClient } from "../codex/ws-client.js";
import type { RuntimeLogger } from "./log.js";

export interface ReconnectCoordinatorOptions {
  connect: () => Promise<CodexWsClient>;
  onClient: (client: CodexWsClient) => void;
  logger: RuntimeLogger;
  maxDelayMs?: number;
}

export class ReconnectCoordinator {
  private connected = true;
  private reconnecting = false;

  constructor(private readonly options: ReconnectCoordinatorOptions) {}

  bind(client: CodexWsClient): void {
    client.onClose((error) => {
      this.connected = false;
      this.options.logger.warn("codex_disconnected", { error: error?.message });
      void this.reconnect();
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    let delayMs = 250;
    const maxDelayMs = this.options.maxDelayMs ?? 5_000;
    for (;;) {
      try {
        this.options.logger.info("codex_reconnect_attempt", { delayMs });
        await delay(delayMs);
        const client = await this.options.connect();
        this.connected = true;
        this.reconnecting = false;
        this.bind(client);
        this.options.onClient(client);
        this.options.logger.info("codex_reconnected");
        return;
      } catch (error) {
        this.options.logger.warn("codex_reconnect_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        delayMs = Math.min(maxDelayMs, Math.floor(delayMs * 1.7));
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
