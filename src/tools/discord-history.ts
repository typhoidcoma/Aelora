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
    "Use 'list_channels' to see available channels, or 'fetch' to retrieve messages. " +
    "When no channelId is given, fetches from all text channels. " +
    "Useful for creating channel digests, summaries, or catching up on conversations.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["fetch", "list_channels"] as const,
      { required: true },
    ),
    channelId: param.string(
      "Specific channel ID to fetch from. If omitted with 'fetch', retrieves from all text channels.",
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

  handler: async ({ action, channelId, limit, hoursBack, includeBotMessages }) => {
    if (!discordClient) return "Error: Discord client is not connected.";

    switch (action) {
      case "list_channels": {
        const channels = getTextChannels();
        if (channels.length === 0) return "No accessible text channels found.";

        const lines = channels.map((ch) => {
          const category = ch.parent?.name ?? "uncategorized";
          return `- **#${ch.name}** (${ch.id}) — ${category}`;
        });

        return `**Text Channels** (${channels.length}):\n${lines.join("\n")}`;
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
            return `No messages found in <#${channelId}> in the last ${hours} hour(s).`;
          }
          return formatChannelBlock(result.channelName, channelId, result.messages);
        }

        // All channels fetch
        const channels = getTextChannels();
        if (channels.length === 0) return "No accessible text channels found.";

        const results: string[] = [];
        let totalMessages = 0;

        for (const ch of channels) {
          const result = await fetchChannelMessages(ch.id, msgLimit, cutoff, skipBots);
          if (result.error || result.messages.length === 0) continue;

          results.push(formatChannelBlock(result.channelName, ch.id, result.messages));
          totalMessages += result.messages.length;
        }

        if (results.length === 0) {
          return `No messages found across any channels in the last ${hours} hour(s).`;
        }

        return (
          `**Channel History** (${totalMessages} messages across ${results.length} channels, last ${hours}h):\n\n` +
          results.join("\n\n---\n\n")
        );
      }

      default:
        return `Unknown action "${action}". Use "fetch" or "list_channels".`;
    }
  },
});

// --- Helpers ---

function getTextChannels(): TextChannel[] {
  if (!discordClient) return [];

  const channels: TextChannel[] = [];
  for (const guild of discordClient.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type === ChannelType.GuildText) {
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
    const channel = await discordClient.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      return { channelName: "unknown", messages: [], error: `Channel ${channelId} is not a text channel` };
    }

    const textChannel = channel as TextChannel;
    const channelName = textChannel.name;

    // Fetch messages (Discord returns newest first)
    const fetched = await textChannel.messages.fetch({ limit });
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
