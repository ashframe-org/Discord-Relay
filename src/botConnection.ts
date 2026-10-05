import { EventEmitter } from "node:events";
import type {
  CubyzConnectionOptions,
  DisconnectEvent,
} from "cubyz-node-client";
import { CubyzConnection } from "cubyz-node-client";
import type {
  Gamemode,
  GenericUpdate,
  PlayersEvent,
} from "cubyz-node-client/dist/connection.js";
import { createChatParser } from "./chatParser.js";
import { createLogger, type Logger } from "./logger.js";
import { cleanUsername } from "./messageFormatter.js";
import type {
  ChatMessage,
  ChatPatterns,
  ConnectionRetryConfig,
  CubyzConnectionConfig,
  LogLevel,
} from "./types.js";

type DisconnectReason = "server" | "stopped" | "retries-exhausted" | "error";

interface ReconnectingPayload {
  attempt: number;
  maxRetries: number | null;
  delayMs: number;
}

interface PlayersPayload {
  players: string[];
}

interface DisconnectPayload {
  reason: DisconnectReason;
  attempts?: number;
}

type BotConnectionEvents = {
  connected: [];
  disconnected: [DisconnectPayload];
  reconnecting: [ReconnectingPayload];
  error: [unknown];
  chat: [ChatMessage];
  players: [PlayersPayload];
  gamemode: [Gamemode];
};

type ConnectionState = "stopped" | "connecting" | "connected";

const toNormalized = (value: string): string => value.toLowerCase();

export interface RelayReply {
  ok: boolean;
  /** "ok" payload, or the error code for "err". */
  text: string;
}

export class BotConnectionManager extends EventEmitter {
  private connection: CubyzConnection | null = null;
  private state: ConnectionState = "stopped";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private requestedStop = false;
  private readonly botNormalizedName: string;
  private readonly excludedNormalizedNames: Set<string>;
  private readonly parseMessage: (message: string) => ChatMessage | null;
  private readonly log: Logger;
  /** Pending `/relay` requests, by request id (see requestRelay). */
  private readonly relayRequests = new Map<
    string,
    { resolve: (reply: RelayReply) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly connectionConfig: CubyzConnectionConfig,
    private readonly retryConfig: ConnectionRetryConfig,
    private readonly logLevel: LogLevel,
    private readonly excludeBotFromCount: boolean,
    excludedUsernames: readonly string[],
    chatPatterns: ChatPatterns,
  ) {
    super();
    this.botNormalizedName = toNormalized(
      cleanUsername(this.connectionConfig.botName ?? ""),
    );
    this.excludedNormalizedNames = new Set(
      excludedUsernames.map((name) => toNormalized(cleanUsername(name))),
    );
    this.parseMessage = createChatParser(chatPatterns);
    this.log = createLogger(logLevel);
  }

  on<K extends keyof BotConnectionEvents>(
    event: K,
    listener: (...args: BotConnectionEvents[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  once<K extends keyof BotConnectionEvents>(
    event: K,
    listener: (...args: BotConnectionEvents[K]) => void,
  ): this {
    return super.once(event, listener);
  }

  off<K extends keyof BotConnectionEvents>(
    event: K,
    listener: (...args: BotConnectionEvents[K]) => void,
  ): this {
    return super.off(event, listener);
  }

  emit<K extends keyof BotConnectionEvents>(
    event: K,
    ...args: BotConnectionEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      return;
    }
    this.requestedStop = false;
    this.retryAttempt = 0;
    this.state = "connecting";
    await this.tryConnect();
  }

  async stop(): Promise<void> {
    this.requestedStop = true;
    this.clearReconnectTimer();
    this.retryAttempt = 0;
    const connection = this.connection;
    if (connection) {
      this.detachListeners(connection);
      connection.close({ notify: true });
      this.connection = null;
    }
    this.state = "stopped";
    this.emit("disconnected", { reason: "stopped" });
  }

  /**
   * Runs `/relay <sub> <req> <args...>` on the server (allowed only for this
   * bot's account) and waits for its `[relay-reply] <req> ok|err ...` line.
   * Arguments must not contain spaces.
   */
  async requestRelay(
    sub: string,
    args: readonly string[],
  ): Promise<RelayReply> {
    if (args.some((a) => a.length === 0 || /\s/.test(a))) {
      return { ok: false, text: "badArgument" };
    }
    const req = Math.random().toString(36).slice(2, 10);
    const result = new Promise<RelayReply>((resolve) => {
      const timer = setTimeout(() => {
        this.relayRequests.delete(req);
        resolve({ ok: false, text: "timeout" });
      }, 10_000);
      this.relayRequests.set(req, { resolve, timer });
    });
    try {
      await this.sendChat(`/relay ${sub} ${req} ${args.join(" ")}`);
    } catch {
      const pending = this.relayRequests.get(req);
      if (pending) {
        clearTimeout(pending.timer);
        this.relayRequests.delete(req);
      }
      return { ok: false, text: "offline" };
    }
    return result;
  }

  async sendChat(message: string): Promise<void> {
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      return;
    }

    if (this.state !== "connected" || !this.connection) {
      throw new Error("Cannot send chat: not connected to Cubyz server.");
    }

    this.connection.sendChat(trimmed);
  }

  private async tryConnect(): Promise<void> {
    if (this.requestedStop) {
      return;
    }

    try {
      await this.openConnection();
    } catch (error) {
      this.handleConnectionFailure(error);
    }
  }

  private async openConnection(): Promise<void> {
    this.cleanupConnection();
    const options: CubyzConnectionOptions = {
      host: this.connectionConfig.host,
      port: this.connectionConfig.port,
      name: this.connectionConfig.botName ?? "",
      version: this.connectionConfig.version,
      logLevel: this.logLevel,
    };
    const connection = new CubyzConnection(options);
    this.connection = connection;
    this.attachListeners(connection);
    await connection.start();
  }

  private handleConnectionFailure(error: unknown): void {
    this.log("error", "Bot failed to connect:", error);
    this.emit("error", error);
    this.cleanupConnection();
    this.state = "connecting";
    if (this.requestedStop || !this.retryConfig.reconnect) {
      this.state = "stopped";
      this.emit("disconnected", { reason: "error" });
      return;
    }
    this.scheduleReconnect();
  }

  private readonly handleConnected = (): void => {
    this.state = "connected";
    this.retryAttempt = 0;
    this.log(
      "debug",
      `Connected to ${this.connectionConfig.host}:${this.connectionConfig.port}`,
    );
    this.emit("connected");
  };

  private readonly handleChat = (message: string): void => {
    const trimmed = message.trim().replace(/(?:\r\n|\r|\n){2,}/g, "\n");
    if (trimmed.length === 0) {
      return;
    }

    // Answers to our own /relay commands (sent only to this bot): never relay.
    const plain = trimmed.replace(/§?#[0-9a-fA-F]{6}/g, "");
    const reply = /^\[relay-reply\] (\S+) (ok|err) ?(.*)$/.exec(plain);
    if (reply) {
      const pending = this.relayRequests.get(reply[1]);
      if (pending) {
        clearTimeout(pending.timer);
        this.relayRequests.delete(reply[1]);
        pending.resolve({ ok: reply[2] === "ok", text: reply[3].trim() });
      }
      return;
    }

    const chatMessage = this.parseMessage(trimmed);
    if (chatMessage) {
      this.emitChatMessage(chatMessage);
    } else {
      this.log("warn", "Unrecognized chat message:", trimmed);
    }
  };

  private readonly handlePlayers = (players: PlayersEvent): void => {
    const normalizedPlayers = players
      // Titled nametags arrive as "[Title]\nName"; the name is the last line.
      .map((player) => cleanUsername(player.name.split("\n").at(-1) ?? ""))
      .filter(Boolean);

    if (this.excludeBotFromCount) {
      const botIndex = normalizedPlayers.findIndex(
        (name) => toNormalized(name) === this.botNormalizedName,
      );
      if (botIndex !== -1) {
        normalizedPlayers.splice(botIndex, 1);
      }
    }

    // Filter out excluded usernames
    const filteredPlayers = normalizedPlayers.filter(
      (name) => !this.excludedNormalizedNames.has(toNormalized(name)),
    );

    this.emit("players", {
      players: filteredPlayers,
    });
  };

  private readonly handleDisconnect = (event: DisconnectEvent): void => {
    this.log("warn", "Disconnected from server:", event.reason);
    this.cleanupConnection();
    if (this.requestedStop) {
      this.state = "stopped";
      return;
    }
    this.state = "connecting";
    this.emit("disconnected", { reason: "server" });
    if (!this.retryConfig.reconnect) {
      this.state = "stopped";
      return;
    }
    this.scheduleReconnect();
  };

  private readonly handleGenericUpdate = (update: GenericUpdate): void => {
    if (update.type === "gamemode") {
      this.emit("gamemode", update.gamemode);
    }
  };

  private attachListeners(connection: CubyzConnection): void {
    connection.on("connected", this.handleConnected);
    connection.on("chat", this.handleChat);
    connection.on("players", this.handlePlayers);
    connection.on("disconnect", this.handleDisconnect);
    connection.on("genericUpdate", this.handleGenericUpdate);
  }

  private detachListeners(connection: CubyzConnection): void {
    connection.off("connected", this.handleConnected);
    connection.off("chat", this.handleChat);
    connection.off("players", this.handlePlayers);
    connection.off("disconnect", this.handleDisconnect);
  }

  private cleanupConnection(): void {
    if (!this.connection) {
      return;
    }
    this.detachListeners(this.connection);
    this.connection = null;
  }

  private emitChatMessage(chatMessage: ChatMessage): void {
    if (chatMessage.username.length === 0) {
      return;
    }
    this.emit("chat", chatMessage);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.retryAttempt += 1;
    const maxRetries =
      this.retryConfig.maxRetries > 0 ? this.retryConfig.maxRetries : null;
    if (maxRetries !== null && this.retryAttempt > maxRetries) {
      this.log(
        "error",
        `Failed to reconnect after ${this.retryAttempt - 1} attempts`,
      );
      this.emit("disconnected", {
        reason: "retries-exhausted",
        attempts: this.retryAttempt - 1,
      });
      this.state = "stopped";
      return;
    }

    const delayMs = Math.round(this.retryConfig.retryDelayMs);
    this.emit("reconnecting", {
      attempt: this.retryAttempt,
      maxRetries,
      delayMs,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.requestedStop) {
        return;
      }
      void this.tryConnect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
