import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { getLLMResponse } from "./llm.js";
import { loadReplyChecked, saveReplyChecked } from "./state.js";
import { processAttachments } from "./discord/attachments.js";
import { recordMessage } from "./sessions.js";
import { updateUser } from "./users.js";
import { appendLog } from "./daily-log.js";
import { classifyMood } from "./mood.js";
import { chunkMessage } from "./utils.js";
import type { Message, TextChannel } from "discord.js";

// Run every 5 minutes (skip most heartbeat ticks)
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
// Only consider messages from the last 30 minutes
const MAX_MESSAGE_AGE_MS = 30 * 60 * 1000;
// Cap replies per tick to avoid flooding
const MAX_REPLIES_PER_TICK = 3;
// How many recent messages to fetch per channel
const FETCH_LIMIT = 20;
// Max tracked message IDs before pruning old entries
const MAX_TRACKED_IDS = 500;

let lastCheck = 0;

const checkedMessages = new Set<string>(loadReplyChecked());

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
    const repliedPreviews: string[] = [];

    for (const guild of discordClient.guilds.cache.values()) {
      if (repliedCount >= MAX_REPLIES_PER_TICK) break;

      for (const channel of guild.channels.cache.values()) {
        if (repliedCount >= MAX_REPLIES_PER_TICK) break;
        if (!channel.isTextBased() || !("messages" in channel)) continue;

        const textChannel = channel as TextChannel;

        let messages;
        try {
          messages = await textChannel.messages.fetch({ limit: FETCH_LIMIT });
        } catch {
          continue; // No permission or channel inaccessible
        }

        // Sort oldest-first so we reply in chronological order
        const sorted = [...messages.values()].sort(
          (a, b) => a.createdTimestamp - b.createdTimestamp,
        );

        // Build a set of message IDs the bot has already replied to in this batch
        const botRepliedTo = new Set<string>();
        for (const msg of sorted) {
          if (msg.author.id === botUserId && msg.reference?.messageId) {
            botRepliedTo.add(msg.reference.messageId);
          }
        }

        for (const msg of sorted) {
          if (repliedCount >= MAX_REPLIES_PER_TICK) break;
          if (msg.author.id === botUserId) continue;
          if (msg.author.bot) continue;
          if (msg.createdTimestamp < cutoff) continue;
          if (checkedMessages.has(msg.id)) continue;
          if (botRepliedTo.has(msg.id)) {
            // Bot already replied to this one normally
            checkedMessages.add(msg.id);
            continue;
          }

          // Check if this message is an @mention or a reply to the bot
          const isMention = msg.mentions.has(botUserId);
          const isReplyToBot =
            msg.reference?.messageId != null &&
            sorted.some(
              (m) =>
                m.id === msg.reference!.messageId &&
                m.author.id === botUserId,
            );

          if (!isMention && !isReplyToBot) {
            // If it's a reply to the bot but the referenced message isn't in our fetched batch,
            // try fetching the referenced message directly
            if (msg.reference?.messageId) {
              try {
                const referenced = await textChannel.messages.fetch(msg.reference.messageId);
                if (referenced.author.id !== botUserId) {
                  checkedMessages.add(msg.id);
                  continue;
                }
                // Fall through to reply logic
              } catch {
                checkedMessages.add(msg.id);
                continue;
              }
            } else {
              checkedMessages.add(msg.id);
              continue;
            }
          }

          // This message needs a reply
          checkedMessages.add(msg.id);

          try {
            let content = msg.content;
            if (botUserId) {
              content = content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
            }

            if (!content && msg.attachments.size === 0) continue;

            const channelName = "name" in msg.channel ? (msg.channel.name as string) : "DM";

            // Track session and user
            recordMessage({
              channelId: msg.channelId,
              guildId: msg.guild?.id ?? null,
              channelName,
              userId: msg.author.id,
              username: msg.author.displayName ?? msg.author.username,
            });
            updateUser(msg.author.id, msg.author.displayName ?? msg.author.username, msg.channelId);

            // Process attachments if present
            const userContent = await processAttachments(msg, content, ctx.config.llm.model);

            console.log(`Reply-check: responding to missed message from ${msg.author.username} in #${channelName}`);

            const text = await getLLMResponse(msg.channelId, userContent, undefined, msg.author.id);

            if (text && text.trim().length > 0) {
              const chunks = chunkMessage(text);
              await (msg as Message).reply(chunks[0]);
              for (let i = 1; i < chunks.length; i++) {
                await textChannel.send(chunks[i]);
              }
              repliedCount++;
              repliedPreviews.push(`${msg.author.username} in #${channelName}`);

              // Side effects (best-effort)
              try {
                const userSnippet = (typeof userContent === "string" ? userContent : content).slice(0, 200);
                appendLog({
                  channelName,
                  userId: msg.author.id,
                  username: msg.author.displayName ?? msg.author.username,
                  summary: `**User:** ${userSnippet}\n**Bot:** ${text.slice(0, 200)}`,
                });
              } catch { /* best effort */ }

              const userText = typeof userContent === "string" ? userContent : content;
              classifyMood(text, userText).catch(() => {});
            }
          } catch (err) {
            console.error(`Reply-check: failed to reply to message ${msg.id}:`, err);
          }
        }
      }
    }

    // Prune tracked IDs if the set gets too large
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
