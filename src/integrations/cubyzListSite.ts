import type { Gamemode } from "cubyz-node-client";
import type { BotConnectionManager } from "../botConnection.js";
import { createLogger, type Logger } from "../logger.js";
import type {
  ChatMessage,
  Config,
  CubyzListSiteConfig,
  LogLevel,
} from "../types.js";
import type { BaseIntegration, IntegrationStatusContext } from "./base.js";

export class CubyzListSiteIntegration implements BaseIntegration {
  readonly name = "AshframeDirectory";
  private players = new Set<string>();
  private online = false;
  private gamemode = "";
  private timer: NodeJS.Timeout | null = null;
  private readonly config: CubyzListSiteConfig;
  private readonly version: string;
  private readonly logger: Logger;

  constructor(config: Config) {
    this.config = config.integration.cubyzlistSite;
    this.version = config.cubyz.version;
    this.logger = createLogger(config.logLevel);
  }

  private log(level: LogLevel, ...args: unknown[]) {
    this.logger(level, `[${this.name}]`, ...args);
  }

  setBotConnection(_bot: BotConnectionManager) {}

  async start(): Promise<void> {
    if (!this.config.token) {
      this.log(
        "warn",
        "Directory integration is enabled but no relay token is configured.",
      );
      return;
    }
    await this.sendUpdate();
    this.timer = setInterval(() => void this.sendUpdate(), 5 * 60 * 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.online = false;
    this.players.clear();
    await this.sendUpdate();
  }

  async updatePlayers(players: readonly string[]): Promise<void> {
    this.players = new Set(players);
    await this.sendUpdate();
  }

  async updateStatus(
    status: "online" | "offline",
    _context?: IntegrationStatusContext,
  ): Promise<void> {
    this.online = status === "online";
    if (!this.online) this.players.clear();
    await this.sendUpdate();
  }

  async updateGamemode(gamemode: Gamemode): Promise<void> {
    this.gamemode =
      gamemode === 0 ? "Survival" : gamemode === 1 ? "Creative" : "";
    await this.sendUpdate();
  }

  async relayChatMessage(_chatMessage: ChatMessage): Promise<void> {}
  async sendMessage(_message: string): Promise<void> {}

  private async sendUpdate(): Promise<void> {
    if (!this.config.token) return;
    const url = `${this.config.endpoint.replace(/\/$/, "")}/api/v1/relay/update`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          online: this.online,
          playerCount: this.players.size,
          version: this.version,
          gamemode: this.gamemode,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      this.log("warn", "Directory update failed:", error);
    }
  }
}
