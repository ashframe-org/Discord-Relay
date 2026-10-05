import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Gamemode } from "cubyz-node-client";
import type { BotConnectionManager } from "../botConnection.js";
import { createLogger, type Logger } from "../logger.js";
import type { ChatMessage, Config, LogLevel, ObsFileConfig } from "../types.js";
import type { BaseIntegration, IntegrationStatusContext } from "./base.js";

/**
 * Writes the online player count to a text file for an OBS text source.
 * Players are already filtered by excludedUsernames before they reach here.
 */
export class ObsFileIntegration implements BaseIntegration {
  readonly name = "ObsFile";
  private count = 0;
  private pending: Promise<void> = Promise.resolve();
  private readonly config: ObsFileConfig;
  private readonly filePath: string;
  private readonly logger: Logger;

  constructor(config: Config) {
    this.config = config.integration.obsFile;
    this.filePath = this.config.path.replace(/^~(?=$|\/)/, os.homedir());
    this.logger = createLogger(config.logLevel);
  }

  private log(level: LogLevel, ...args: unknown[]) {
    this.logger(level, `[${this.name}]`, ...args);
  }

  setBotConnection(_bot: BotConnectionManager) {}

  async start(): Promise<void> {
    if (!this.filePath) {
      this.log("warn", "OBS file integration is enabled but no path is configured.");
      return;
    }
    await this.write();
  }

  async stop(): Promise<void> {
    this.count = 0;
    await this.write();
  }

  async updatePlayers(players: readonly string[]): Promise<void> {
    this.count = players.length;
    await this.write();
  }

  async updateStatus(
    status: "online" | "offline",
    _context?: IntegrationStatusContext,
  ): Promise<void> {
    if (status === "offline") {
      this.count = 0;
      await this.write();
    }
  }

  async updateGamemode(_gamemode: Gamemode): Promise<void> {}
  async relayChatMessage(_chatMessage: ChatMessage): Promise<void> {}
  async sendMessage(_message: string): Promise<void> {}

  // Writes share one temp file, so run them one at a time.
  private write(): Promise<void> {
    this.pending = this.pending.then(() => this.writeNow());
    return this.pending;
  }

  private async writeNow(): Promise<void> {
    if (!this.filePath) return;
    const text = this.config.format.replaceAll("{count}", String(this.count));
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tmp, `${text}\n`);
      await rename(tmp, this.filePath);
    } catch (error) {
      this.log("warn", "Failed to write player count file:", error);
    }
  }
}
