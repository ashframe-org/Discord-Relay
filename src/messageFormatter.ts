import type { ChatMessage, Config, EventType } from "./types.js";

export function cleanUsername(raw: string): string {
  let result = raw;

  result = result.replace(/§#[0-9A-Fa-f]{6}/g, "");
  result = result.replace(/#[0-9A-Fa-f]{6}/g, "");
  // Server-side season/badge tags, e.g. "[S2]", are plain text (only the
  // color code is stripped), so they'd otherwise leak into Discord as
  // "S2 Name". Drop the season badge specifically; leave arbitrary
  // bracket text (admin prefixes) alone.
  result = result.replace(/\[S\d\]/g, " ");
  result = result.replace(/[*~_[\]]/g, "");
  result = result.replace(/[^\p{L}\p{N}_\- ]/gu, "");

  return result.replace(/\s+/g, " ").trim();
}

const censorMessage = (
  message: string,
  censorlist: readonly string[],
): string => {
  if (!message || censorlist.length === 0) {
    return message;
  }

  const normalizedTerms = censorlist
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (normalizedTerms.length === 0) {
    return message;
  }

  return message
    .split(/(\s+)/)
    .map((segment) => {
      if (segment.trim().length === 0) {
        return segment;
      }

      const lowerSegment = segment.toLowerCase();
      const containsTerm = normalizedTerms.some((term) =>
        lowerSegment.includes(term),
      );

      return containsTerm ? "||beep||" : segment;
    })
    .join("");
};

const stripCubyzColorCodes = (value: string): string =>
  value.replace(/§#[0-9A-Fa-f]{6}/g, "").replace(/#[0-9A-Fa-f]{6}/g, "");

/**
 * True when a chat line's (already cleaned) username refers to the relay bot.
 * Matches exactly or as a trailing segment, so badge/prefix decoration like
 * "S2 Discord" or "adm Discord" is still recognised as the bot — otherwise the
 * bot's own relayed message echoes back into Discord (infinite repeat).
 */
export function isBotUsername(
  cleanedUsername: string,
  botNormalizedName: string,
): boolean {
  if (botNormalizedName.length === 0) {
    return false;
  }
  const username = cleanedUsername.toLowerCase();
  return (
    username === botNormalizedName || username.endsWith(` ${botNormalizedName}`)
  );
}

export function formatMessage(
  chatMessage: ChatMessage,
  config?: Config,
): string {
  const username = chatMessage.username;

  switch (chatMessage.type) {
    case "join":
      return `👋 **${username} joined the game**`;
    case "leave":
      return `🚪 **${username} left the game**`;
    case "death":
      return `💀 **${username} ${chatMessage.message ?? "died"}**`;
    case "chat":
      return `**${username}**: ${censorMessage(
        stripCubyzColorCodes(chatMessage.message ?? "").trimStart(),
        config?.censorlist ?? [],
      )}`;
    default:
      return `**${username}**: ${chatMessage.message ?? ""}`;
  }
}

export function shouldRelayEvent(
  eventType: EventType,
  config: Config,
): boolean {
  return config.events.includes(eventType);
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "avif",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "aac"]);

const MAX_FILENAME_LENGTH = 60;

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** How to describe one attachment: image / video / audio / file. */
function describeAttachment(
  contentType: string | null,
  filename: string,
): { noun: string; name: string } {
  const ext = extensionOf(filename);
  const mime = (contentType ?? "").toLowerCase();
  let noun = "file";
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) noun = "image";
  else if (mime.startsWith("video/") || VIDEO_EXTENSIONS.has(ext))
    noun = "video";
  else if (mime.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext))
    noun = "audio";
  return { noun, name: truncate(filename, MAX_FILENAME_LENGTH) };
}

export interface MessageExtrasInput {
  attachments: ReadonlyArray<{ name: string; contentType: string | null }>;
  embeds: ReadonlyArray<{ title: string | null; url: string | null }>;
  stickerNames: readonly string[];
}

/**
 * Short in-game description of a Discord message's non-text content, or null if
 * there is none. Attachments are grouped by kind; embeds and stickers are noted
 * separately. Filenames only (truncated); never URLs (not clickable in-game).
 */
export function describeMessageExtras(
  input: MessageExtrasInput,
): string | null {
  const parts: string[] = [];

  const counts = { image: 0, video: 0, audio: 0, file: 0 };
  const named: string[] = [];
  for (const attachment of input.attachments) {
    const { noun, name } = describeAttachment(
      attachment.contentType,
      attachment.name,
    );
    counts[noun as keyof typeof counts] += 1;
    if (input.attachments.length <= 3) {
      named.push(`${noun}: ${name}`);
    }
  }
  if (input.attachments.length > 0) {
    if (named.length > 0) {
      parts.push(`sent ${named.join(", ")}`);
    } else {
      const total = input.attachments.length;
      const kinds = (
        Object.entries(counts) as Array<[keyof typeof counts, number]>
      )
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`);
      parts.push(`sent ${total} attachments (${kinds.join(", ")})`);
    }
  }

  for (const embed of input.embeds) {
    const label = embed.title?.trim();
    parts.push(
      label
        ? `sent an embed: ${truncate(label, MAX_FILENAME_LENGTH)}`
        : "sent an embed",
    );
  }

  for (const sticker of input.stickerNames) {
    parts.push(`sent a sticker: ${truncate(sticker, MAX_FILENAME_LENGTH)}`);
  }

  return parts.length > 0 ? parts.join("; ") : null;
}
