import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { getLLMResponse } from "./llm.js";
import { loadReplyChecked, saveReplyChecked } from "./state.js";
import { processAttachments } from "./discord/attachments.js";
import { recordMessage, getAllSessions } from "./sessions.js";
import { updateUser } from "./users.js";
import { appendLog } from "./daily-log.js";
import { classifyMood } from "./mood.js";
import { chunkMessage } from "./utils.js";
import type { Message, TextChannel } from "discord.js";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MESSAGE_AGE_MS = 30 * 60 * 1000;
const MAX_REPLIES_PER_TICK = 3;
const FETCH_LIMIT = 20;
const MAX_TRACKED_IDS = 500;
const MAX_FETCH_REQUESTS_PER_TICK = 25;
const FETCH_TIMEOUT_MS = 6_000;
const LLM_TIMEOUT_MS = 45_000;
const ACTIVE_CHANNEL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

let lastCheck = 0;

const checkedMessages = new Set<string>(loadReplyChecked());
const channelCursor = new Map<string, number>();

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function collectCandidateChannels(
  discordClient: { guilds: { cache: Map<string, { channels: { cache: Map<string, unknown> } }> } },
  allowedChannelIds: string[],
): TextChannel[] {
  const out: TextChannel[] = [];
  const seen = new Set<string>();
  const now = Date.now();

  const pushIfTextChannel = (value: unknown): void => {
    const channel = value as TextChannel;
    if (!channel?.id || seen.has(channel.id)) return;
    if (!channel.isTextBased() || !("messages" in channel)) return;
    seen.add(channel.id);
    out.push(channel);
  };

  for (const guild of discordClient.guilds.cache.values()) {
    for (const channelId of allowedChannelIds) {
      pushIfTextChannel(guild.channels.cache.get(channelId));
    }
  }

  const recentSessions = getAllSessions()
    .filter((s) => now - new Date(s.lastMessage).getTime() <= ACTIVE_CHANNEL_LOOKBACK_MS)
    .sort((a, b) => new Date(b.lastMessage).getTime() - new Date(a.lastMessage).getTime())
    .slice(0, 30);

  for (const session of recentSessions) {
    for (const guild of discordClient.guilds.cache.values()) {
      pushIfTextChannel(guild.channels.cache.get(session.channelId));
    }
  }

  if (out.length === 0) {
    for (const guild of discordClient.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        pushIfTextChannel(channel);
      }
    }
  }

  return out;
}

const replyCheck: HeartbeatHandler = {
  name: "reply-check",
  description: "Scans channels for @mentions and replies the bot missed",
  enabled: true,

  execute: async (ctx): Promise<string | void> => {
    const now = Date.now();
    if (now - lastCheck < CHECK_INTERVAL_MS) return;
    lastCheck = now;

    const { discordClient, botUserId } = await import("./discord.js");
    if (!discordClient || !botUserId) return;

    const cutoff = now - MAX_MESSAGE_AGE_MS;
    let repliedCount = 0;
    let fetchRequests = 0;
    const repliedPreviews: string[] = [];
    const allowedChannels = ctx.config.discord.allowedChannels ?? [];
    const channels = collectCandidateChannels(
      discordClient as unknown as { guilds: { cache: Map<string, { channels: { cache: Map<string, unknown> } }> } },
      allowedChannels,
    );

    for (const textChannel of channels) {
      if (repliedCount >= MAX_REPLIES_PER_TICK || fetchRequests >= MAX_FETCH_REQUESTS_PER_TICK) break;

      let messages;
      try {
        fetchRequests++;
        messages = await withTimeout(textChannel.messages.fetch({ limit: FETCH_LIMIT }), FETCH_TIMEOUT_MS, "message fetch");
      } catch {
        continue;
      }

      const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const botRepliedTo = new Set<string>();
      for (const msg of sorted) {
        if (msg.author.id === botUserId && msg.reference?.messageId) {
          botRepliedTo.add(msg.reference.messageId);
        }
      }

      let maxSeenTs = channelCursor.get(textChannel.id) ?? cutoff;

      for (const msg of sorted) {
        if (msg.createdTimestamp > maxSeenTs) maxSeenTs = msg.createdTimestamp;
        if (repliedCount >= MAX_REPLIES_PER_TICK) break;
        if (msg.author.id === botUserId || msg.author.bot) continue;
        if (msg.createdTimestamp < cutoff) continue;
        if (msg.createdTimestamp <= (channelCursor.get(textChannel.id) ?? cutoff)) continue;
        if (checkedMessages.has(msg.id)) continue;
        if (botRepliedTo.has(msg.id)) {
          checkedMessages.add(msg.id);
          continue;
        }

        const isMention = msg.mentions.has(botUserId);
        const isReplyToBot =
          msg.reference?.messageId != null &&
          sorted.some((m) => m.id === msg.reference!.messageId && m.author.id === botUserId);

        if (!isMention && !isReplyToBot) {
          if (msg.reference?.messageId) {
            try {
              fetchRequests++;
              if (fetchRequests > MAX_FETCH_REQUESTS_PER_TICK) break;
              const referenced = await withTimeout(
                textChannel.messages.fetch(msg.reference.messageId),
                FETCH_TIMEOUT_MS,
                "reference fetch",
              );
              if (referenced.author.id !== botUserId) {
                checkedMessages.add(msg.id);
                continue;
              }
            } catch {
              checkedMessages.add(msg.id);
              continue;
            }
          } else {
            checkedMessages.add(msg.id);
            continue;
          }
        }

        checkedMessages.add(msg.id);

        try {
          let content = msg.content;
          content = content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();

          if (!content && msg.attachments.size === 0) continue;

          const channelName = "name" in msg.channel ? (msg.channel.name as string) : "DM";

          recordMessage({
            channelId: msg.channelId,
            guildId: msg.guild?.id ?? null,
            channelName,
            userId: msg.author.id,
            username: msg.author.displayName ?? msg.author.username,
          });
          updateUser(msg.author.id, msg.author.displayName ?? msg.author.username, msg.channelId);

          const userContent = await withTimeout(
            processAttachments(msg, content, ctx.config.llm.model),
            LLM_TIMEOUT_MS,
            "attachment processing",
          );

          console.log(`Reply-check: responding to missed message from ${msg.author.username} in #${channelName}`);

          const text = await withTimeout(
            getLLMResponse(msg.channelId, userContent, undefined, msg.author.id),
            LLM_TIMEOUT_MS,
            "reply generation",
          );

          if (text && text.trim().length > 0) {
            const chunks = chunkMessage(text);
            await (msg as Message).reply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
              await textChannel.send(chunks[i]);
            }
            repliedCount++;
            repliedPreviews.push(`${msg.author.username} in #${channelName}`);

            try {
              const userSnippet = (typeof userContent === "string" ? userContent : content).slice(0, 200);
              appendLog({
                channelName,
                userId: msg.author.id,
                username: msg.author.displayName ?? msg.author.username,
                summary: `**User:** ${userSnippet}\n**Bot:** ${text.slice(0, 200)}`,
              });
            } catch {
              // best effort
            }

            const userText = typeof userContent === "string" ? userContent : content;
            classifyMood(text, userText, msg.channelId).catch(() => {});
          }
        } catch (err) {
          console.error(`Reply-check: failed to reply to message ${msg.id}:`, err);
        }
      }

      channelCursor.set(textChannel.id, maxSeenTs);
    }

    if (checkedMessages.size > MAX_TRACKED_IDS) {
      const arr = [...checkedMessages];
      const trimmed = arr.slice(arr.length - MAX_TRACKED_IDS);
      checkedMessages.clear();
      for (const id of trimmed) checkedMessages.add(id);
    }

    saveReplyChecked([...checkedMessages]);

    if (repliedCount > 0) {
      return `replied to ${repliedCount} missed message(s): ${repliedPreviews.join(", ")}`;
    }
  },
};

export function registerReplyCheck(): void {
  registerHeartbeatHandler(replyCheck);
}
