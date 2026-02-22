import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import type { Config } from "../config.js";
import { getLLMResponse } from "../llm.js";
import { chunkMessage } from "../utils.js";
import { processAttachments } from "./attachments.js";
import { setEmbedColor } from "./embeds.js";
import { getSlashCommandDefinitions, handleSlashCommand } from "./commands.js";
import { recordMessage } from "../sessions.js";
import { appendLog } from "../daily-log.js";

export let discordClient: Client | null = null;
export let botUserId: string | null = null;

export async function startDiscord(config: Config): Promise<Client> {
  if (config.discord.embedColor !== undefined) {
    setEmbedColor(config.discord.embedColor);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const ready = new Promise<void>((resolve) => {
    client.once(Events.ClientReady, async (readyClient) => {
      botUserId = readyClient.user.id;
      discordClient = client;

      readyClient.user.setPresence({
        status: "online",
        activities: [{ name: config.discord.status, type: 3 }],
      });

      // Register slash commands
      try {
        const commands = getSlashCommandDefinitions();
        if (config.discord.guildId) {
          const guild = readyClient.guilds.cache.get(config.discord.guildId);
          if (guild) {
            await guild.commands.set(commands);
            console.log(
              `Discord: registered ${commands.length} slash command(s) (guild: ${guild.name})`,
            );
            // Clear any stale global commands to prevent duplicates
            const globalCount = (await readyClient.application.commands.fetch()).size;
            if (globalCount > 0) {
              await readyClient.application.commands.set([]);
              console.log(`Discord: cleared ${globalCount} stale global command(s)`);
            }
          } else {
            console.warn(`Discord: guild ${config.discord.guildId} not found in cache — commands not registered`);
          }
        } else {
          // Fetch existing commands to preserve Discord-managed ones (e.g. Activity Entry Point)
          const existing = await readyClient.application.commands.fetch();
          const entryPoints = existing.filter((cmd) => cmd.type !== 1).map((cmd) => cmd.toJSON());

          const allCommands = [...commands.map((c) => c.toJSON()), ...entryPoints] as Parameters<typeof readyClient.application.commands.set>[0];
          await readyClient.application.commands.set(allCommands);
          console.log(
            `Discord: registered ${commands.length} slash command(s) (global, preserved ${entryPoints.length} entry point(s))`,
          );
        }
      } catch (err) {
        console.error("Discord: failed to register slash commands:", err);
      }

      console.log(
        `Discord: logged in as ${readyClient.user.tag} (${readyClient.guilds.cache.size} guilds)`,
      );
      resolve();
    });
  });

  // --- Message handler ---
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.id === botUserId) return;
    if (message.author.bot) return;

    const isDM = !message.guild;

    if (isDM) {
      if (!config.discord.allowDMs) return;
      await handleMessage(message, config);
      return;
    }

    if (config.discord.allowedChannels.length > 0) {
      if (!config.discord.allowedChannels.includes(message.channelId)) return;
    }

    if (config.discord.guildMode === "mention") {
      if (!botUserId || !message.mentions.has(botUserId)) return;
    }

    await handleMessage(message, config);
  });

  // --- Interaction handler (slash commands) ---
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction, config.llm.model);
      }
    } catch (err: unknown) {
      // Interaction expired (10062) or already acknowledged (40060) — not a crash
      const code = (err as { code?: number }).code;
      if (code === 10062 || code === 40060) {
        console.warn(`Discord: interaction expired or already acked (code ${code})`);
        return;
      }
      console.error("Discord: interaction handler error:", err);
    }
  });

  await client.login(config.discord.token);
  await ready;

  return client;
}

const STREAM_EDIT_INTERVAL = 1200;
const TYPING_INTERVAL = 8_000;
const OVERFLOW_THRESHOLD = 1800;

async function handleMessage(message: Message, config: Config): Promise<void> {
  let content = message.content;
  if (botUserId) {
    content = content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  }

  // Allow messages with only attachments (no text)
  if (!content && message.attachments.size === 0) return;

  // Track session analytics
  const channelName = "name" in message.channel ? (message.channel.name as string) : "DM";
  recordMessage({
    channelId: message.channelId,
    guildId: message.guild?.id ?? null,
    channelName,
    userId: message.author.id,
    username: message.author.displayName ?? message.author.username,
  });

  const channel = message.channel;
  if (!channel.isSendable()) return;

  let replyMsg: Message | null = null;
  let activeMsg: Message | null = null;
  let editTimer: ReturnType<typeof setInterval> | null = null;
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  try {
    // Keep typing indicator alive throughout response generation
    await channel.sendTyping();
    typingTimer = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, TYPING_INTERVAL);

    const userContent = await processAttachments(message, content, config.llm.model);

    // Streaming state — no placeholder reply; typing indicator covers the wait
    let buffer = "";
    let lastEditTime = 0;
    let activeOffset = 0;
    let streamDone = false;
    let inflightEdit: Promise<unknown> | null = null;

    const doEdit = async () => {
      if (streamDone) return;

      const pending = buffer.slice(activeOffset);
      if (pending.length === 0) return;

      const now = Date.now();
      if (now - lastEditTime < STREAM_EDIT_INTERVAL) return;
      lastEditTime = now;

      if (!activeMsg) {
        // First content — send as a reply to the user's message
        const p = message.reply(pending + " \u25CF").then((msg) => {
          activeMsg = msg;
          replyMsg = msg;
        }).catch(() => {});
        inflightEdit = p;
        await p;
        return;
      }

      // Overflow: finalize current message and continue in a new one
      if (pending.length > OVERFLOW_THRESHOLD) {
        let splitAt = pending.lastIndexOf("\n", OVERFLOW_THRESHOLD);
        if (splitAt < OVERFLOW_THRESHOLD * 0.3) {
          splitAt = pending.lastIndexOf(" ", OVERFLOW_THRESHOLD);
        }
        if (splitAt <= 0) splitAt = OVERFLOW_THRESHOLD;

        const p = activeMsg.edit(pending.slice(0, splitAt)).catch(() => {});
        inflightEdit = p;
        await p;
        activeOffset += splitAt;

        const overflow = buffer.slice(activeOffset);
        if (overflow.length > 0) {
          const p2 = channel.send(overflow + " \u25CF").then((msg) => {
            activeMsg = msg;
          }).catch(() => {});
          inflightEdit = p2;
          await p2;
        }
      } else {
        const p = activeMsg.edit(pending + " \u25CF").catch(() => {});
        inflightEdit = p;
        await p;
      }
    };

    editTimer = setInterval(doEdit, STREAM_EDIT_INTERVAL);

    const text = await getLLMResponse(message.channelId, userContent, (token) => {
      buffer += token;
    }, message.author.id);

    // Stop streaming edits and wait for any in-flight Discord API call to settle
    streamDone = true;
    clearInterval(editTimer);
    editTimer = null;
    if (inflightEdit) await inflightEdit;
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }

    if (!text || text.trim().length === 0) {
      if (activeMsg) {
        await (activeMsg as Message).edit("_(no response)_");
      } else {
        await message.reply("_(no response)_");
      }
      return;
    }

    // Append to daily conversation log (best-effort, never breaks chat)
    try {
      const userSnippet = (typeof userContent === "string" ? userContent : content).slice(0, 200);
      const botSnippet = text.slice(0, 200);
      appendLog({
        channelName,
        userId: message.author.id,
        username: message.author.displayName ?? message.author.username,
        summary: `**User:** ${userSnippet}\n**Bot:** ${botSnippet}`,
      });
    } catch { /* swallow */ }

    // Finalize: properly chunk the remaining text
    const remaining = text.slice(activeOffset);
    const chunks = chunkMessage(remaining);

    if (activeMsg) {
      await (activeMsg as Message).edit(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await channel.send(chunks[i]);
      }
    } else {
      // No streaming content was sent yet — send final reply directly
      replyMsg = await message.reply(chunks[0]);
      activeMsg = replyMsg;
      for (let i = 1; i < chunks.length; i++) {
        await channel.send(chunks[i]);
      }
    }
  } catch (err) {
    if (editTimer) clearInterval(editTimer);
    if (typingTimer) clearInterval(typingTimer);
    console.error("Discord handler error:", err);
    try {
      const errorTarget = activeMsg ?? replyMsg;
      if (errorTarget) {
        await errorTarget.edit("Sorry, I encountered an error processing your message.");
      } else {
        await message.reply("Sorry, I encountered an error processing your message.");
      }
    } catch {
      // swallow
    }
  }
}

/**
 * Send a message to a Discord channel by ID (used by cron, heartbeat).
 * Defaults to plain text for backward compatibility.
 */
export async function sendToChannel(
  channelId: string,
  text: string,
): Promise<void> {
  if (!discordClient) throw new Error("Discord client not connected");

  const channel = await discordClient.channels.fetch(channelId);
  if (!channel || !channel.isSendable()) {
    throw new Error(`Channel ${channelId} is not a text channel`);
  }

  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}
