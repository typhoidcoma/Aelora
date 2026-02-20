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
          }
        } else {
          await readyClient.application.commands.set(commands);
          console.log(
            `Discord: registered ${commands.length} slash command(s) (global)`,
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

async function handleMessage(message: Message, config: Config): Promise<void> {
  let content = message.content;
  if (botUserId) {
    content = content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  }

  // Allow messages with only attachments (no text)
  if (!content && message.attachments.size === 0) return;

  try {
    const channel = message.channel;
    if (!channel.isSendable()) return;

    await channel.sendTyping();

    // Process attachments (images → content parts, text files → inlined)
    const userContent = await processAttachments(message, content, config.llm.model);

    const text = await getLLMResponse(message.channelId, userContent);

    if (!text || text.trim().length === 0) {
      await message.reply("_(no response)_");
      return;
    }

    const chunks = chunkMessage(text);
    await message.reply(chunks[0]);

    for (let i = 1; i < chunks.length; i++) {
      await channel.send(chunks[i]);
    }
  } catch (err) {
    console.error("Discord handler error:", err);
    try {
      await message.reply("Sorry, I encountered an error processing your message.");
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
