import type { Gamemode } from "cubyz-node-client";
import type {
  ApplicationCommand,
  Client,
  Interaction,
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";
import { Events, MessageFlags } from "discord.js";
import type { BotConnectionManager } from "../botConnection.js";
import {
  cleanup as cleanupDiscordClient,
  initializeDiscordClient,
  sendMessage,
  updatePlayerCount as updateDiscordPresence,
} from "../discordClient.js";
import { createLogger, type Logger } from "../logger.js";
import {
  cleanUsername,
  describeMessageExtras,
  formatMessage,
  isBotUsername,
  shouldRelayEvent,
} from "../messageFormatter.js";
import type { ChatMessage, Config, LogLevel } from "../types.js";
import type { BaseIntegration, IntegrationStatusContext } from "./base.js";

interface CachedMessage {
  rawUsername: string;
  username: string;
  content: string;
  timestamp: number;
}

const MESSAGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_CUBYZ_COLOR_RESET = "#FFFFFF";
const DISCORD_MESSAGE_LIMIT = 2000;
const MAX_PLAYER_LIST_ENTRIES = 50;

const collapseWhitespace = (input: string): string =>
  input.replace(/\s+/g, " ").trim();

export class DiscordIntegration implements BaseIntegration {
  readonly name = "Discord";

  private readonly config: Config;
  private readonly messageCache = new Map<string, CachedMessage>();
  private readonly botNormalizedName: string;
  private client: Client<boolean> | null = null;
  private bot: BotConnectionManager | null = null;
  private isReady = false;
  private currentPlayers: string[] = [];
  private readonly logger: Logger;

  constructor(config: Config) {
    this.config = config;
    this.botNormalizedName = cleanUsername(
      config.cubyz.botName ?? "",
    ).toLowerCase();
    this.logger = createLogger(config.logLevel);
  }

  private log(level: LogLevel, ...args: unknown[]) {
    this.logger(level, `[${this.name}]`, ...args);
  }

  setBotConnection(bot: BotConnectionManager): void {
    this.bot = bot;
  }

  async start(): Promise<void> {
    if (!this.config.discord.enabled || this.isReady) {
      return;
    }

    this.log("info", "Connecting to Discord...");
    const client = await initializeDiscordClient(
      this.config.discord.token,
      this.config.discord.allowedMentions,
      this.config.logLevel,
    );
    this.client = client;
    this.log("info", "Connected to Discord.");

    client.on("messageCreate", this.handleMessageCreate);
    client.on("messageReactionAdd", this.handleReactionAdd);
    client.on("interactionCreate", this.handleInteractionCreate);

    if (client.isReady()) {
      await this.registerSlashCommands();
    } else {
      client.once(Events.ClientReady, () => {
        void this.registerSlashCommands();
      });
    }

    this.isReady = true;
    await this.sendMessage("**🤖 Bot has joined chat**");
    await this.updatePresence(0);
  }

  async stop(): Promise<void> {
    if (!this.config.discord.enabled || !this.isReady) {
      return;
    }

    await this.sendMessage("**🤖 Bot has left chat**");

    this.isReady = false;
    const client = this.client;
    if (client) {
      client.off("messageCreate", this.handleMessageCreate);
      client.off("messageReactionAdd", this.handleReactionAdd);
      client.off("interactionCreate", this.handleInteractionCreate);
    }

    this.messageCache.clear();
    this.client = null;
    await cleanupDiscordClient();
  }

  async updatePlayers(players: readonly string[]): Promise<void> {
    this.currentPlayers = [...players];

    if (!this.isActive()) {
      return;
    }

    await this.updatePresence(players.length);
  }

  async updateStatus(
    status: "online" | "offline",
    context?: IntegrationStatusContext,
  ): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    if (status === "offline") {
      await this.updatePresence(0);
    }

    const statusMessage = this.resolveStatusMessage(status, context);
    if (statusMessage) {
      await this.sendMessage(statusMessage);
    }
  }

  async updateGamemode(_gamemode: Gamemode) {}

  async relayChatMessage(chatMessage: ChatMessage): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    if (!shouldRelayEvent(chatMessage.type, this.config)) {
      return;
    }

    if (
      chatMessage.type === "chat" &&
      this.botNormalizedName.length > 0 &&
      isBotUsername(chatMessage.username, this.botNormalizedName)
    ) {
      return;
    }

    try {
      const payload = formatMessage(chatMessage, this.config);
      const sentMessage = await sendMessage(
        this.config.discord.channelId,
        payload,
      );

      if (chatMessage.type === "chat" && chatMessage.message) {
        this.messageCache.set(sentMessage.id, {
          rawUsername: chatMessage.rawUsername,
          username: chatMessage.username,
          content: chatMessage.message,
          timestamp: Date.now(),
        });

        if (this.messageCache.size % 50 === 0) {
          this.cleanMessageCache();
        }
      }
    } catch (error) {
      this.log("error", "Failed to send message to Discord:", error);
    }
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.isActive() || message.trim().length === 0) {
      return;
    }

    try {
      await sendMessage(this.config.discord.channelId, message);
    } catch (error) {
      this.log("error", "Failed to send notification to Discord:", error);
    }
  }

  private cleanMessageCache(): void {
    const now = Date.now();
    for (const [id, entry] of this.messageCache.entries()) {
      if (now - entry.timestamp > MESSAGE_CACHE_TTL_MS) {
        this.messageCache.delete(id);
      }
    }
  }

  private async updatePresence(playerCount: number): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    try {
      await updateDiscordPresence(playerCount);
    } catch (error) {
      this.log("error", "Failed to update Discord presence:", error);
    }
  }

  private readonly handleMessageCreate = async (
    message: Message,
  ): Promise<void> => {
    if (!this.isActive()) {
      return;
    }

    if (message.channelId !== this.config.discord.channelId) {
      return;
    }

    if (message.author.bot || message.system) {
      return;
    }

    const normalizedContent = collapseWhitespace(message.cleanContent);

    // Describe any non-text content (images, files, embeds, stickers) so an
    // attachment-only message is still relayed instead of being dropped.
    const extras = describeMessageExtras({
      attachments: message.attachments.map((attachment) => ({
        name: attachment.name ?? "file",
        contentType: attachment.contentType ?? null,
      })),
      embeds: message.embeds.map((embed) => ({
        title: embed.title ?? null,
        url: embed.url ?? null,
      })),
      stickerNames: message.stickers.map((sticker) => sticker.name),
    });

    if (normalizedContent.length === 0 && !extras) {
      return;
    }

    if (normalizedContent.startsWith("/")) {
      const handled = await this.handleCommand(normalizedContent, message);
      if (handled) {
        return;
      }
    }

    if (!this.bot) {
      this.log(
        "warn",
        "Received Discord message before Cubyz connection was ready.",
      );
      return;
    }

    const name = this.resolveDiscordDisplayName(message);
    const color = this.resolveDiscordHexColor(message);

    // Combine text and any attachment/embed/sticker description.
    const body =
      normalizedContent.length > 0 && extras
        ? `${normalizedContent} (${extras})`
        : normalizedContent.length > 0
          ? normalizedContent
          : (extras ?? "");

    let payload =
      color && color !== "#FFFFFF"
        ? `${color}${name}${DEFAULT_CUBYZ_COLOR_RESET}: ${body}`
        : `${name}: ${body}`;

    if (this.config.discord.enableReplies && message.reference?.messageId) {
      const referencedMsg = this.messageCache.get(message.reference.messageId);
      if (referencedMsg) {
        const replyPrefix = `replying to ${referencedMsg.rawUsername}: *"${referencedMsg.content}"*`;
        const fullMessage = `${replyPrefix} - ${body}`;
        payload =
          color && color !== "#FFFFFF"
            ? `${color}${name}${DEFAULT_CUBYZ_COLOR_RESET}: ${fullMessage}`
            : `${name}: ${fullMessage}`;
      }
    }

    try {
      await this.bot.sendChat(payload);
    } catch (error) {
      this.log("error", "Failed to relay Discord message to Cubyz:", error);
    }
  };

  private async registerSlashCommands(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const channel = await this.client.channels.fetch(
        this.config.discord.channelId,
      );
      if (!channel || !channel.isTextBased()) {
        this.log(
          "warn",
          "Cannot register slash command: configured channel is not text-based.",
        );
        return;
      }

      if (!("guild" in channel) || !channel.guild) {
        this.log(
          "warn",
          "Cannot register slash command: configured channel is not in a guild.",
        );
        return;
      }

      const guild = channel.guild;

      const commandDefinition = {
        name: "list",
        description: "Show the players currently online in Cubyz.",
      } as const;

      const existingCommands = await guild.commands.fetch();
      const existing = existingCommands.find(
        (command: ApplicationCommand) =>
          command.name === commandDefinition.name,
      );

      if (!existing) {
        await guild.commands.create(commandDefinition);
        this.log("info", "Registered /list slash command.");
      } else if (existing.description !== commandDefinition.description) {
        await guild.commands.edit(existing.id, commandDefinition);
        this.log("info", "Updated /list slash command.");
      }
    } catch (error) {
      this.log("error", "Failed to register slash command:", error);
    }
  }

  private async handleCommand(
    content: string,
    message: Message,
  ): Promise<boolean> {
    const [command] = content.split(/\s+/, 1);
    if (command.toLowerCase() === "/list") {
      await this.handleListCommand(message);
      return true;
    }

    return false;
  }

  private async handleListCommand(message: Message): Promise<void> {
    const response = this.formatPlayerListResponse(this.currentPlayers);

    try {
      await message.reply({
        content: response,
        allowedMentions: { repliedUser: false },
      });
    } catch (error) {
      this.log("error", "Failed to respond to /list command:", error);
    }
  }

  private formatPlayerListResponse(players: readonly string[]): string {
    if (players.length === 0) {
      return "No players are currently connected";
    }

    const displayedPlayers = players.slice(0, MAX_PLAYER_LIST_ENTRIES);
    let response = `Players online (${players.length}): ${displayedPlayers.join(", ")}`;

    if (players.length > displayedPlayers.length) {
      response = `${response}, ...and ${players.length - displayedPlayers.length} more`;
    }

    if (response.length <= DISCORD_MESSAGE_LIMIT) {
      return response;
    }

    const numberedLines = displayedPlayers.map(
      (player, index) => `${index + 1}. ${player}`,
    );
    const lines = [`Players online (${players.length}):`, ...numberedLines];
    response = lines.join("\n");

    if (players.length > displayedPlayers.length) {
      response = `${response}\n...and ${players.length - displayedPlayers.length} more`;
    }

    if (response.length <= DISCORD_MESSAGE_LIMIT) {
      return response;
    }

    return "Player list is too long to display";
  }

  private readonly handleInteractionCreate = async (
    interaction: Interaction,
  ): Promise<void> => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName !== "list") {
      return;
    }

    const response = this.formatPlayerListResponse(this.currentPlayers);

    try {
      await interaction.reply({
        content: response,
      });
    } catch (error) {
      if (!interaction.deferred && !interaction.replied) {
        try {
          await interaction.reply({
            content: "Unable to display player list right now",
            flags: MessageFlags.Ephemeral,
          });
        } catch (innerError) {
          this.log(
            "error",
            "Failed to send fallback response for /list command:",
            innerError,
          );
        }
      }
      this.log("error", "Failed to respond to /list slash command:", error);
    }
  };

  private readonly handleReactionAdd = async (
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> => {
    if (!this.config.discord.enableReactions || !this.isActive()) {
      return;
    }

    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (error) {
        this.log("error", "Failed to fetch reaction:", error);
        return;
      }
    }

    if (reaction.message.channelId !== this.config.discord.channelId) {
      return;
    }

    if ("bot" in user && user.bot) {
      return;
    }

    if (!this.bot) {
      this.log(
        "warn",
        "Received Discord reaction before Cubyz connection was ready.",
      );
      return;
    }

    const guild = reaction.message.guild;
    const member = guild
      ? await guild.members.fetch(user.id).catch(() => null)
      : null;

    const candidateName =
      member?.displayName ??
      ("globalName" in user && user.globalName) ??
      ("username" in user && user.username) ??
      (user.id ? `User${user.id.slice(-4)}` : null);

    if (!candidateName) {
      return;
    }

    const reactorName = cleanUsername(candidateName);
    if (reactorName.length === 0) {
      return;
    }

    const emoji = reaction.emoji.name ?? "?";
    const referencedMsg = this.messageCache.get(reaction.message.id);

    let payload: string;
    if (referencedMsg) {
      payload = `${reactorName} reacted to ${referencedMsg.rawUsername}: *"${referencedMsg.content}"* with ${emoji}`;
    } else {
      payload = `${reactorName} reacted with ${emoji}`;
    }

    try {
      await this.bot.sendChat(payload);
    } catch (error) {
      this.log("error", "Failed to relay Discord reaction to Cubyz:", error);
    }
  };

  private resolveDiscordDisplayName(message: Message): string {
    const preferred =
      message.member?.displayName ??
      message.author.globalName ??
      message.author.username;

    const primary = cleanUsername(preferred ?? message.author.username);
    if (primary.length > 0) {
      return primary;
    }

    const fallback = cleanUsername(message.author.username);
    if (fallback.length > 0) {
      return fallback;
    }

    return `User${message.author.id.slice(-4)}`;
  }

  private resolveDiscordHexColor(message: Message): string | null {
    const hex = message.member?.displayHexColor;
    if (!hex || hex === "#000000") {
      return null;
    }

    return hex.toUpperCase();
  }

  private isActive(): boolean {
    return this.config.discord.enabled && this.isReady && this.client !== null;
  }

  private resolveStatusMessage(
    status: "online" | "offline",
    context?: IntegrationStatusContext,
  ): string | null {
    if (status === "online") {
      return context?.reason === "connected"
        ? "🟢 **Bot connected to server**"
        : null;
    }

    switch (context?.reason) {
      case "retries-exhausted": {
        const attemptText =
          typeof context.attempts === "number" && context.attempts > 0
            ? ` after ${context.attempts} attempts`
            : "";
        return `❌ **Failed to reconnect${attemptText}**`;
      }
      case "server":
        return "🔴 **Bot disconnected from server**";
      case "error":
        return "⚠️ **Bot connection failed**";
      default:
        return null;
    }
  }
}
