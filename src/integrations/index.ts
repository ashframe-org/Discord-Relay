import type { Gamemode } from "cubyz-node-client";
import type { BotConnectionManager } from "../botConnection.js";
import { createLogger, type Logger } from "../logger.js";
import type { ChatMessage, Config } from "../types.js";
import type { BaseIntegration, IntegrationStatusContext } from "./base.js";
import { CubyzListSiteIntegration } from "./cubyzListSite.js";
import { DiscordIntegration } from "./discord.js";
import { ObsFileIntegration } from "./obsFile.js";

interface IntegrationDependencies {
  bot: BotConnectionManager;
}

export function createIntegrations(
  config: Config,
  dependencies: IntegrationDependencies,
): BaseIntegration[] {
  const integrations: BaseIntegration[] = [];

  if (config.discord.enabled) {
    const discordIntegration = new DiscordIntegration(config);
    discordIntegration.setBotConnection(dependencies.bot);
    integrations.push(discordIntegration);
  }

  if (config.integration.cubyzlistSite.enabled) {
    const listIntegration = new CubyzListSiteIntegration(config);
    listIntegration.setBotConnection(dependencies.bot);
    integrations.push(listIntegration);
  }

  if (config.integration.obsFile.enabled) {
    integrations.push(new ObsFileIntegration(config));
  }

  return integrations;
}

export class IntegrationManager {
  private integrations: BaseIntegration[];
  private readonly log: Logger;

  constructor(config: Config, dependencies: IntegrationDependencies) {
    this.integrations = createIntegrations(config, dependencies);
    this.log = createLogger(config.logLevel);

    if (this.integrations.length > 0) {
      this.log(
        "info",
        `Initialized ${this.integrations.length} integration(s): ${this.integrations.map((i) => i.name).join(", ")}`,
      );
    }
  }

  async startAll(): Promise<void> {
    await Promise.allSettled(
      this.integrations.map(async (integration) => {
        try {
          await integration.start();
        } catch (error) {
          this.log(
            "error",
            `Failed to start integration ${integration.name}:`,
            error,
          );
        }
      }),
    );
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      this.integrations.map(async (integration) => {
        try {
          await integration.stop();
        } catch (error) {
          this.log(
            "error",
            `Failed to stop integration ${integration.name}:`,
            error,
          );
        }
      }),
    );
  }

  async updatePlayers(players: readonly string[]): Promise<void> {
    await Promise.allSettled(
      this.integrations.map(async (integration) => {
        try {
          await integration.updatePlayers(players);
        } catch (error) {
          this.log(
            "error",
            `Failed to update players for integration ${integration.name}:`,
            error,
          );
        }
      }),
    );
  }

  async updateStatus(
    status: "online" | "offline",
    context?: IntegrationStatusContext,
  ): Promise<void> {
    await Promise.allSettled(
      this.integrations.map(async (integration) => {
        try {
          await integration.updateStatus(status, context);
        } catch (error) {
          this.log(
            "error",
            `Failed to update status for integration ${integration.name}:`,
            error,
          );
        }
      }),
    );
  }

  async updateGamemode(gamemode: Gamemode): Promise<void> {
    await Promise.allSettled(
      this.integrations.map(async (integration) => {
        try {
          await integration.updateGamemode(gamemode);
        } catch (error) {
          this.log(
            "error",
            `Failed to update gamemode for integration ${integration.name}:`,
            error,
          );
        }
      }),
    );
  }

  async relayChatMessage(chatMessage: ChatMessage): Promise<void> {
    await Promise.allSettled(
      this.integrations.map(async (integration) => {
        try {
          await integration.relayChatMessage(chatMessage);
        } catch (error) {
          this.log(
            "error",
            `Failed to relay chat message for integration ${integration.name}:`,
            error,
          );
        }
      }),
    );
  }

  async sendMessage(message: string): Promise<void> {
    if (message.trim().length === 0) {
      return;
    }

    await Promise.allSettled(
      this.integrations.map(async (integration) => {
        try {
          await integration.sendMessage(message);
        } catch (error) {
          this.log(
            "error",
            `Failed to send notification via integration ${integration.name}:`,
            error,
          );
        }
      }),
    );
  }
}
