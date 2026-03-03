import { ChannelType, type TextChannel } from "discord.js";
import { defineTool, param } from "./types.js";
import { discordClient, botUserId } from "../discord.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_HOURS_BACK = 24;
const MAX_HOURS_BACK = 168; // 7 days

export default defineTool({
  name: "discord_history",
  description:
    "Fetch recent message history from Discord text channels. " +
    "Actions: 'list_channels' (see all channels with their IDs), 'fetch' (retrieve messages). " +
    "To fetch a specific channel, pass its ID as channelId. " +
    "When no channelId is given, 'fetch' retrieves from all text channels. " +
    "Useful for creating channel digests, summaries, or catching up on conversations.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["fetch", "list_channels"] as const,
      { required: true },
    ),
    channelId: param.string(
      "Specific channel ID to fetch from (pass as a quoted string, e.g. \"1234567890\"). If omitted with 'fetch', retrieves from all text channels.",
    ),
    limit: param.number(
      `Max messages per channel (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      { minimum: 1, maximum: MAX_LIMIT },
    ),
    hoursBack: param.number(
      `Only include messages from the last N hours (default ${DEFAULT_HOURS_BACK}, max ${MAX_HOURS_BACK}).`,
      { minimum: 1, maximum: MAX_HOURS_BACK },
    ),
    includeBotMessages: param.boolean(
      "Include messages from bots (default false). When false, bot messages are excluded.",
    ),
  },

  handler: async ({ action, channelId: rawChannelId, limit, hoursBack, includeBotMessages }) => {
    if (!discordClient) return "Error: Discord client is not connected.";
    // Coerce channelId to string — models sometimes pass Discord snowflakes as numbers,
    // which lose precision (snowflakes exceed Number.MAX_SAFE_INTEGER).
    const channelId = rawChannelId != null ? String(rawChannelId) : undefined;

    switch (action) {
      case "list_channels": {
        const channels = await getTextChannels();
        if (channels.length === 0) return "No accessible text channels found.";

        const lines = channels.map((ch) => {
          const category = ch.parent?.name ?? "uncategorized";
          return `- **#${ch.name}** (${ch.id}) — ${category}`;
        });

        return {
          text: `**Text Channels** (${channels.length}):\n${lines.join("\n")}`,
          data: {
            action: "list_channels",
            count: channels.length,
            channels: channels.map(ch => ({ id: ch.id, name: ch.name, category: ch.parent?.name ?? null })),
          },
        };
      }

      case "fetch": {
        const msgLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
        const hours = Math.min(hoursBack ?? DEFAULT_HOURS_BACK, MAX_HOURS_BACK);
        const cutoff = Date.now() - hours * 60 * 60 * 1000;
        const skipBots = !includeBotMessages;

        if (channelId) {
          // Single channel fetch
          const result = await fetchChannelMessages(channelId, msgLimit, cutoff, skipBots);
          if (result.error) return `Error: ${result.error}`;
          if (result.messages.length === 0) {
            return { text: `No messages found in <#${channelId}> in the last ${hours} hour(s).`, data: { action: "fetch", channelId, count: 0, messages: [] } };
          }
          return {
            text: formatChannelBlock(result.channelName, channelId, result.messages),
            data: {
              action: "fetch",
              channelId,
              channelName: result.channelName,
              count: result.messages.length,
              messages: result.messages,
            },
          };
        }

        // All channels fetch
        const channels = await getTextChannels();
        if (channels.length === 0) return "No accessible text channels found.";

        const results: string[] = [];
        const channelsData: { channelId: string; channelName: string; count: number; messages: FormattedMessage[] }[] = [];
        let totalMessages = 0;

        for (const ch of channels) {
          const result = await fetchChannelMessages(ch.id, msgLimit, cutoff, skipBots);
          if (result.error || result.messages.length === 0) continue;

          results.push(formatChannelBlock(result.channelName, ch.id, result.messages));
          channelsData.push({ channelId: ch.id, channelName: result.channelName, count: result.messages.length, messages: result.messages });
          totalMessages += result.messages.length;
        }

        if (results.length === 0) {
          return { text: `No messages found across any channels in the last ${hours} hour(s).`, data: { action: "fetch", count: 0, channels: [] } };
        }

        return {
          text: `**Channel History** (${totalMessages} messages across ${results.length} channels, last ${hours}h):\n\n` +
            results.join("\n\n---\n\n"),
          data: {
            action: "fetch",
            totalMessages,
            channelCount: results.length,
            channels: channelsData,
          },
        };
      }

      default:
        return `Unknown action "${action}". Use "fetch" or "list_channels".`;
    }
  },
});

// --- Helpers ---

async function getTextChannels(): Promise<TextChannel[]> {
  if (!discordClient) return [];

  const channels: TextChannel[] = [];
  for (const guild of discordClient.guilds.cache.values()) {
    // Fetch from the API so newly-created channels are always included
    const fetched = await guild.channels.fetch().catch(() => null);
    const source = fetched ?? guild.channels.cache;
    for (const channel of source.values()) {
      if (channel && channel.type === ChannelType.GuildText) {
        channels.push(channel as TextChannel);
      }
    }
  }

  // Sort by category then name for consistent ordering
  channels.sort((a, b) => {
    const catA = a.parent?.name ?? "";
    const catB = b.parent?.name ?? "";
    if (catA !== catB) return catA.localeCompare(catB);
    return a.name.localeCompare(b.name);
  });

  return channels;
}

type FetchResult = {
  channelName: string;
  messages: FormattedMessage[];
  error?: string;
};

type FormattedMessage = {
  author: string;
  authorId: string;
  isBot: boolean;
  timestamp: string;
  content: string;
};

async function fetchChannelMessages(
  channelId: string,
  limit: number,
  cutoffMs: number,
  skipBots: boolean,
): Promise<FetchResult> {
  if (!discordClient) return { channelName: "unknown", messages: [], error: "Client not connected" };

  try {
    // Search guild caches first — same path as list_channels uses, avoids
    // client.channels.fetch() which can fail for channels that guild.channels.fetch() returns fine.
    let textChannel: TextChannel | null = null;
    for (const guild of discordClient.guilds.cache.values()) {
      const cached = guild.channels.cache.get(channelId);
      if (cached?.type === ChannelType.GuildText) {
        textChannel = cached as TextChannel;
        break;
      }
    }

    // Not in any guild cache — fetch from each guild's API (same as getTextChannels)
    if (!textChannel) {
      for (const guild of discordClient.guilds.cache.values()) {
        let ch;
        try {
          ch = await guild.channels.fetch(channelId);
        } catch (err: unknown) {
          const code = (err as { code?: number }).code;
          const status = (err as { status?: number }).status;
          if (status === 403 || code === 50013) {
            return { channelName: "unknown", messages: [], error: `Missing VIEW_CHANNEL permission on channel ${channelId}. Grant the bot View Channel access in Discord server settings.` };
          }
          continue; // not in this guild, try the next one
        }
        if (ch?.type === ChannelType.GuildText) {
          textChannel = ch as TextChannel;
          break;
        }
      }
    }

    if (!textChannel) {
      return { channelName: "unknown", messages: [], error: `Channel ${channelId} not found in any accessible guild. Use list_channels to get valid IDs.` };
    }

    const channelName = textChannel.name;

    // Fetch messages (Discord returns newest first)
    let fetched;
    try {
      fetched = await textChannel.messages.fetch({ limit });
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      const code = (err as { code?: number }).code;
      if (status === 403 || code === 50013) {
        return { channelName, messages: [], error: `Missing READ_MESSAGE_HISTORY permission in #${channelName}. Grant the bot Read Message History access in Discord server settings.` };
      }
      throw err;
    }
    const messages: FormattedMessage[] = [];

    for (const msg of fetched.values()) {
      // Time filter
      if (msg.createdTimestamp < cutoffMs) continue;

      // Bot filter
      if (skipBots && msg.author.bot) continue;

      // Skip empty messages with no useful content
      if (!msg.content && msg.embeds.length === 0 && msg.attachments.size === 0) continue;

      let content = msg.content || "";

      // Note embeds and attachments
      if (msg.embeds.length > 0) {
        const embedSummaries = msg.embeds.map((e) => e.title || e.description?.slice(0, 100) || "embed").join(", ");
        content += content ? ` [embeds: ${embedSummaries}]` : `[embeds: ${embedSummaries}]`;
      }
      if (msg.attachments.size > 0) {
        const attachNames = [...msg.attachments.values()].map((a) => a.name).join(", ");
        content += content ? ` [files: ${attachNames}]` : `[files: ${attachNames}]`;
      }

      messages.push({
        author: msg.author.displayName ?? msg.author.username,
        authorId: msg.author.id,
        isBot: msg.author.bot,
        timestamp: msg.createdAt.toISOString(),
        content,
      });
    }

    // Sort chronologically (oldest first)
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return { channelName, messages };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { channelName: "unknown", messages: [], error: errMsg };
  }
}

function formatChannelBlock(name: string, id: string, messages: FormattedMessage[]): string {
  const lines = messages.map((m) => {
    const time = new Date(m.timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const botTag = m.isBot ? " [BOT]" : "";
    return `[${time}] ${m.author}${botTag}: ${m.content}`;
  });

  return `**#${name}** (${messages.length} messages):\n${lines.join("\n")}`;
}
