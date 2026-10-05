import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";
import type {
  AllowedMentionType,
  ChatPatterns,
  Config,
  ConnectionRetryConfig,
  CubyzConnectionConfig,
  CubyzListSiteConfig,
  EventType,
  IntegrationConfig,
  ObsFileConfig,
  LogLevel,
} from "./types.js";

const DEFAULT_EVENTS: EventType[] = ["join", "leave", "death", "chat"];
const SUPPORTED_EVENTS: EventType[] = [...DEFAULT_EVENTS];
const DEFAULT_CENSORLIST: string[] = [];
const DEFAULT_EXCLUDED_USERNAMES: string[] = [];
const DEFAULT_CUBYZ: CubyzConnectionConfig = {
  host: "127.0.0.1",
  port: 47649,
  botName: "Discord",
  version: "0.0.0",
};
const DEFAULT_CONNECTION: ConnectionRetryConfig = {
  reconnect: true,
  maxRetries: 0,
  retryDelayMs: 30000,
};
const DEFAULT_ALLOWED_MENTIONS: AllowedMentionType[] = [];
const DEFAULT_EXCLUDE_BOT_FROM_COUNT = true;
const DEFAULT_STARTUP_MESSAGE_DELAY = 0;
const DEFAULT_LOG_LEVEL: LogLevel = "info";
const ALLOWED_LOG_LEVELS: readonly LogLevel[] = [
  "error",
  "debug",
  "info",
  "warn",
  "silent",
];
const DEFAULT_CUBYZLIST_SITE: CubyzListSiteConfig = {
  enabled: false,
  endpoint: "https://servers.ashframe.net",
  token: "",
  serverName: "",
  serverIp: "",
  description: undefined,
  serverPort: undefined,
  iconUrl: undefined,
  discordServer: undefined,
  customClientDownloadUrl: undefined,
};
export const DEFAULT_CHAT_PATTERNS: ChatPatterns = {
  chat: { pattern: "^\\[(?<username>.+?)\\]\\s*(?<message>[\\s\\S]*)$" },
  join: { pattern: "^(?<username>.+?) joined$" },
  leave: { pattern: "^(?<username>.+?) left$" },
  death: { pattern: "^(?<username>.+?) died(?<message>.*)$" },
};
const CONFIG_TEMPLATE_PATH = fileURLToPath(
  new URL("../config.example.json", import.meta.url),
);

const ALLOWED_MENTION_TYPES: AllowedMentionType[] = [
  "roles",
  "users",
  "everyone",
];

const isAllowedMentionType = (value: unknown): value is AllowedMentionType =>
  typeof value === "string" &&
  ALLOWED_MENTION_TYPES.includes(value as AllowedMentionType);

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: string }).code === "ENOENT";

export class ConfigTemplateCreatedError extends Error {
  readonly configPath: string;

  constructor(configPath: string) {
    super(
      `Configuration file not found. A template has been created at ${configPath}. Update it and rerun the application.`,
    );
    this.name = "ConfigTemplateCreatedError";
    this.configPath = configPath;
  }
}

function coercePort(value: unknown, fallback: number): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 65535
  ) {
    return value;
  }
  return fallback;
}

function coerceOptionalPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 65535
  ) {
    return value;
  }

  return undefined;
}

function coerceString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function applyDefaults(partial: Partial<Config>): Config {
  const events =
    Array.isArray(partial.events) && partial.events.length > 0
      ? [...partial.events]
      : DEFAULT_EVENTS;

  const censorlistSource = Array.isArray(partial.censorlist)
    ? partial.censorlist
    : DEFAULT_CENSORLIST;

  const censorlist = censorlistSource
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const startupMessages = Array.isArray(partial.startupMessages)
    ? partial.startupMessages
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];

  const excludedUsernamesSource = Array.isArray(partial.excludedUsernames)
    ? partial.excludedUsernames
    : DEFAULT_EXCLUDED_USERNAMES;

  const excludedUsernames = excludedUsernamesSource
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const cubyz: CubyzConnectionConfig = {
    host: coerceString(partial.cubyz?.host, DEFAULT_CUBYZ.host),
    port: coercePort(partial.cubyz?.port, DEFAULT_CUBYZ.port),
    botName: partial.cubyz?.botName?.trim() || undefined,
    version: coerceString(partial.cubyz?.version, DEFAULT_CUBYZ.version),
  };

  const allowedMentionsSource = Array.isArray(partial.discord?.allowedMentions)
    ? partial.discord.allowedMentions
    : DEFAULT_ALLOWED_MENTIONS;

  const allowedMentions = Array.from(
    new Set(allowedMentionsSource.filter(isAllowedMentionType)),
  );

  const connection: ConnectionRetryConfig = {
    reconnect:
      typeof partial.connection?.reconnect === "boolean"
        ? partial.connection.reconnect
        : DEFAULT_CONNECTION.reconnect,
    maxRetries:
      typeof partial.connection?.maxRetries === "number" &&
      Number.isInteger(partial.connection.maxRetries) &&
      partial.connection.maxRetries >= 0
        ? partial.connection.maxRetries
        : DEFAULT_CONNECTION.maxRetries,
    retryDelayMs:
      typeof partial.connection?.retryDelayMs === "number" &&
      partial.connection.retryDelayMs >= 0
        ? Math.floor(partial.connection.retryDelayMs)
        : DEFAULT_CONNECTION.retryDelayMs,
  };

  const cubyzlistSite: CubyzListSiteConfig = {
    enabled:
      typeof partial.integration?.cubyzlistSite?.enabled === "boolean"
        ? partial.integration.cubyzlistSite.enabled
        : DEFAULT_CUBYZLIST_SITE.enabled,
    endpoint: coerceString(
      partial.integration?.cubyzlistSite?.endpoint,
      DEFAULT_CUBYZLIST_SITE.endpoint,
    ),
    token: coerceString(partial.integration?.cubyzlistSite?.token, ""),
    serverName: coerceString(
      partial.integration?.cubyzlistSite?.serverName,
      DEFAULT_CUBYZLIST_SITE.serverName,
    ),
    serverIp: coerceString(
      partial.integration?.cubyzlistSite?.serverIp,
      DEFAULT_CUBYZLIST_SITE.serverIp,
    ),
    description:
      coerceString(
        partial.integration?.cubyzlistSite?.description,
        DEFAULT_CUBYZLIST_SITE.description ?? "",
      ) || undefined,
    serverPort: coerceOptionalPort(
      partial.integration?.cubyzlistSite?.serverPort,
    ),
    iconUrl:
      coerceString(
        partial.integration?.cubyzlistSite?.iconUrl,
        DEFAULT_CUBYZLIST_SITE.iconUrl ?? "",
      ) || undefined,
    discordServer:
      coerceString(
        partial.integration?.cubyzlistSite?.discordServer,
        DEFAULT_CUBYZLIST_SITE.discordServer ?? "",
      ) || undefined,
    customClientDownloadUrl:
      coerceString(
        partial.integration?.cubyzlistSite?.customClientDownloadUrl,
        DEFAULT_CUBYZLIST_SITE.customClientDownloadUrl ?? "",
      ) || undefined,
  };

  const obsFile: ObsFileConfig = {
    enabled:
      typeof partial.integration?.obsFile?.enabled === "boolean"
        ? partial.integration.obsFile.enabled
        : false,
    path: coerceString(partial.integration?.obsFile?.path, ""),
    format: coerceString(
      partial.integration?.obsFile?.format,
      "Players online: {count}",
    ),
  };

  const integration: IntegrationConfig = {
    cubyzlistSite,
    obsFile,
  };

  const chatPatterns: ChatPatterns = {
    chat: {
      pattern: coerceString(
        partial.chatPatterns?.chat?.pattern,
        DEFAULT_CHAT_PATTERNS.chat.pattern,
      ),
    },
    join: {
      pattern: coerceString(
        partial.chatPatterns?.join?.pattern,
        DEFAULT_CHAT_PATTERNS.join.pattern,
      ),
    },
    leave: {
      pattern: coerceString(
        partial.chatPatterns?.leave?.pattern,
        DEFAULT_CHAT_PATTERNS.leave.pattern,
      ),
    },
    death: {
      pattern: coerceString(
        partial.chatPatterns?.death?.pattern,
        DEFAULT_CHAT_PATTERNS.death.pattern,
      ),
    },
  };

  const logLevel = (() => {
    if (typeof partial.logLevel !== "string") {
      return DEFAULT_LOG_LEVEL;
    }

    const normalized = partial.logLevel.trim().toLowerCase();
    return (ALLOWED_LOG_LEVELS as readonly string[]).includes(normalized)
      ? (normalized as LogLevel)
      : DEFAULT_LOG_LEVEL;
  })();

  return {
    logLevel,
    cubyz,
    connection,
    discord: {
      enabled:
        typeof partial.discord?.enabled === "boolean"
          ? partial.discord.enabled
          : true,
      token: coerceString(partial.discord?.token, ""),
      channelId: coerceString(partial.discord?.channelId, ""),
      allowedMentions,
      enableReactions:
        typeof partial.discord?.enableReactions === "boolean"
          ? partial.discord.enableReactions
          : true,
      enableReplies:
        typeof partial.discord?.enableReplies === "boolean"
          ? partial.discord.enableReplies
          : true,
    },
    events: events as EventType[],
    censorlist,
    startupMessages,
    startupMessageDelay:
      typeof partial.startupMessageDelay === "number" &&
      partial.startupMessageDelay >= 0
        ? Math.floor(partial.startupMessageDelay)
        : DEFAULT_STARTUP_MESSAGE_DELAY,
    excludeBotFromCount:
      typeof partial.excludeBotFromCount === "boolean"
        ? partial.excludeBotFromCount
        : DEFAULT_EXCLUDE_BOT_FROM_COUNT,
    excludedUsernames,
    integration,
    chatPatterns,
  };
}

function finalizeConfig(config: Config): Config {
  const cubyzlist = config.integration.cubyzlistSite;
  if (!cubyzlist.enabled) {
    return config;
  }

  const missingFields: string[] = [];
  if (cubyzlist.endpoint.length === 0) {
    missingFields.push("integration.cubyzlistSite.endpoint");
  }
  if (cubyzlist.token.length === 0) {
    missingFields.push("integration.cubyzlistSite.token");
  }

  if (missingFields.length === 0) {
    return config;
  }

  createLogger(config.logLevel)(
    "warn",
    `[CubyzListSite] Disabled integration because required config field(s) are missing: ${missingFields.join(", ")}`,
  );
  cubyzlist.enabled = false;
  return config;
}

async function ensureConfigFile(resolvedPath: string): Promise<void> {
  try {
    await access(resolvedPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await copyFile(CONFIG_TEMPLATE_PATH, resolvedPath);
      throw new ConfigTemplateCreatedError(resolvedPath);
    }

    throw error;
  }
}

export function validateConfig(config: Config): void {
  if (!config.cubyz || typeof config.cubyz !== "object") {
    throw new Error('Configuration error: "cubyz" section is required.');
  }

  if (
    typeof config.cubyz.host !== "string" ||
    config.cubyz.host.trim().length === 0
  ) {
    throw new Error(
      'Configuration error: "cubyz.host" must be a non-empty string.',
    );
  }

  if (
    typeof config.cubyz.port !== "number" ||
    !Number.isInteger(config.cubyz.port) ||
    config.cubyz.port <= 0 ||
    config.cubyz.port > 65535
  ) {
    throw new Error(
      'Configuration error: "cubyz.port" must be an integer between 1 and 65535.',
    );
  }

  if (
    typeof config.cubyz.version !== "string" ||
    config.cubyz.version.trim().length === 0
  ) {
    throw new Error(
      'Configuration error: "cubyz.version" must be a non-empty string.',
    );
  }

  if (
    typeof config.logLevel !== "string" ||
    !(ALLOWED_LOG_LEVELS as readonly string[]).includes(config.logLevel)
  ) {
    throw new Error(
      `Configuration error: "logLevel" must be one of: ${ALLOWED_LOG_LEVELS.join(", ")}.`,
    );
  }

  if (typeof !config.discord?.enabled !== "boolean") {
    throw new Error(
      'Configuration error: "discord.enabled" must be a boolean.',
    );
  }

  if (config.discord?.enabled) {
    if (!config.discord.token || typeof config.discord.token !== "string") {
      throw new Error('Configuration error: "discord.token" must be provided.');
    }

    if (
      !config.discord.channelId ||
      typeof config.discord.channelId !== "string"
    ) {
      throw new Error(
        'Configuration error: "discord.channelId" must be provided.',
      );
    }
  }

  if (!Array.isArray(config.discord.allowedMentions)) {
    throw new Error(
      'Configuration error: "discord.allowedMentions" must be an array.',
    );
  }

  const unsupportedAllowedMentions = config.discord.allowedMentions.filter(
    (entry) => !ALLOWED_MENTION_TYPES.includes(entry),
  );

  if (unsupportedAllowedMentions.length > 0) {
    throw new Error(
      `Configuration error: "discord.allowedMentions" contains unsupported entries: ${unsupportedAllowedMentions.join(", ")}.`,
    );
  }

  if (!Array.isArray(config.events) || config.events.length === 0) {
    throw new Error(
      'Configuration error: "events" must include at least one supported event type.',
    );
  }

  const unknownEvents = config.events.filter(
    (event) => !SUPPORTED_EVENTS.includes(event),
  );
  if (unknownEvents.length > 0) {
    throw new Error(
      `Configuration error: unsupported event types: ${unknownEvents.join(", ")}.`,
    );
  }

  if (!Array.isArray(config.censorlist)) {
    throw new Error(
      'Configuration error: "censorlist" must be an array of non-empty strings.',
    );
  }

  const invalidCensorlistEntries = config.censorlist.filter(
    (entry) => typeof entry !== "string" || entry.trim().length === 0,
  );
  if (invalidCensorlistEntries.length > 0) {
    throw new Error(
      'Configuration error: "censorlist" must contain only non-empty strings.',
    );
  }

  if (!Array.isArray(config.startupMessages)) {
    throw new Error(
      'Configuration error: "startupMessages" must be an array of non-empty strings.',
    );
  }

  const invalidStartupMessages = config.startupMessages.filter(
    (entry) => typeof entry !== "string" || entry.trim().length === 0,
  );

  if (invalidStartupMessages.length > 0) {
    throw new Error(
      'Configuration error: "startupMessages" must contain only non-empty strings.',
    );
  }

  if (typeof config.excludeBotFromCount !== "boolean") {
    throw new Error(
      'Configuration error: "excludeBotFromCount" must be a boolean value.',
    );
  }

  if (!Array.isArray(config.excludedUsernames)) {
    throw new Error(
      'Configuration error: "excludedUsernames" must be an array of non-empty strings.',
    );
  }

  const invalidExcludedUsernames = config.excludedUsernames.filter(
    (entry) => typeof entry !== "string" || entry.trim().length === 0,
  );

  if (invalidExcludedUsernames.length > 0) {
    throw new Error(
      'Configuration error: "excludedUsernames" must contain only non-empty strings.',
    );
  }

  if (typeof config.connection?.reconnect !== "boolean") {
    throw new Error(
      'Configuration error: "connection.reconnect" must be a boolean value.',
    );
  }

  if (
    typeof config.connection.maxRetries !== "number" ||
    !Number.isInteger(config.connection.maxRetries) ||
    config.connection.maxRetries < 0
  ) {
    throw new Error(
      'Configuration error: "connection.maxRetries" must be a non-negative integer.',
    );
  }

  if (
    typeof config.connection.retryDelayMs !== "number" ||
    config.connection.retryDelayMs < 0
  ) {
    throw new Error(
      'Configuration error: "connection.retryDelayMs" must be a non-negative number.',
    );
  }

  // Validate integration section
  if (!config.integration || typeof config.integration !== "object") {
    throw new Error('Configuration error: "integration" section is required.');
  }

  if (
    !config.integration.cubyzlistSite ||
    typeof config.integration.cubyzlistSite !== "object"
  ) {
    throw new Error(
      'Configuration error: "integration.cubyzlistSite" section is required.',
    );
  }

  const cubyzlist = config.integration.cubyzlistSite;

  if (typeof cubyzlist.enabled !== "boolean") {
    throw new Error(
      'Configuration error: "integration.cubyzlistSite.enabled" must be a boolean.',
    );
  }

  if (typeof cubyzlist.endpoint !== "string") {
    throw new Error(
      'Configuration error: "integration.cubyzlistSite.endpoint" must be a string.',
    );
  }

  if (typeof cubyzlist.token !== "string") {
    throw new Error(
      'Configuration error: "integration.cubyzlistSite.token" must be a string.',
    );
  }

  if (
    cubyzlist.description !== undefined &&
    (typeof cubyzlist.description !== "string" || cubyzlist.description === "")
  ) {
    throw new Error(
      'Configuration error: "integration.cubyzlistSite.description" must be a non-empty string or undefined.',
    );
  }

  if (cubyzlist.enabled) {
    if (
      cubyzlist.serverPort !== undefined &&
      (typeof cubyzlist.serverPort !== "number" ||
        !Number.isInteger(cubyzlist.serverPort) ||
        cubyzlist.serverPort <= 0 ||
        cubyzlist.serverPort > 65535)
    ) {
      throw new Error(
        'Configuration error: "integration.cubyzlistSite.serverPort" must be an integer between 1 and 65535 or undefined.',
      );
    }

    if (
      cubyzlist.iconUrl !== undefined &&
      (typeof cubyzlist.iconUrl !== "string" || cubyzlist.iconUrl === "")
    ) {
      throw new Error(
        'Configuration error: "integration.cubyzlistSite.iconUrl" must be a non-empty string or undefined.',
      );
    }

    if (
      cubyzlist.discordServer !== undefined &&
      (typeof cubyzlist.discordServer !== "string" ||
        cubyzlist.discordServer === "")
    ) {
      throw new Error(
        'Configuration error: "integration.cubyzlistSite.discordServer" must be a non-empty string or undefined.',
      );
    }

    if (
      cubyzlist.customClientDownloadUrl !== undefined &&
      (typeof cubyzlist.customClientDownloadUrl !== "string" ||
        cubyzlist.customClientDownloadUrl === "")
    ) {
      throw new Error(
        'Configuration error: "integration.cubyzlistSite.customClientDownloadUrl" must be a non-empty string or undefined.',
      );
    }
  }

  if (!config.chatPatterns || typeof config.chatPatterns !== "object") {
    throw new Error('Configuration error: "chatPatterns" section is required.');
  }

  const eventTypes: EventType[] = ["chat", "join", "leave", "death"];
  for (const type of eventTypes) {
    const entry = (config.chatPatterns as Record<string, unknown>)[type];
    if (entry == null || typeof entry !== "object") {
      throw new Error(
        `Configuration error: "chatPatterns.${type}" must be an object with a "pattern" string.`,
      );
    }
    const patternValue = (entry as Record<string, unknown>).pattern;
    if (typeof patternValue !== "string" || patternValue.trim().length === 0) {
      throw new Error(
        `Configuration error: "chatPatterns.${type}.pattern" must be a non-empty string.`,
      );
    }
    try {
      new RegExp(patternValue);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Configuration error: "chatPatterns.${type}.pattern" is not a valid regular expression: ${reason}`,
      );
    }
  }
}

export async function loadConfig(configPath: string): Promise<Config> {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  await ensureConfigFile(resolvedPath);
  const raw = await readFile(resolvedPath, "utf8");
  const parsedUnknown = JSON.parse(raw) as Record<string, unknown>;
  if ("cubyzLogPath" in parsedUnknown) {
    throw new Error(
      "Configuration error: detected legacy log-based settings. Update the configuration file to use the bot connection schema.",
    );
  }
  const config = finalizeConfig(
    applyDefaults(parsedUnknown as Partial<Config>),
  );
  validateConfig(config);
  return config;
}
