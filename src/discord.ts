import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import type { Config } from "./config.js";
import { getLLMResponse } from "./llm.js";
import { chunkMessage } from "./utils.js";

export let discordClient: Client | null = null;
export let botUserId: string | null = null;

export async function startDiscord(config: Config): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Partials needed to receive DMs
    partials: [Partials.Channel],
  });

  // Wait for the client to be ready before returning
  const ready = new Promise<void>((resolve) => {
    client.once(Events.ClientReady, (readyClient) => {
      botUserId = readyClient.user.id;
      discordClient = client;

      readyClient.user.setPresence({
        status: "online",
        activities: [{ name: config.discord.status, type: 3 }], // 3 = Watching
      });

      console.log(
        `Discord: logged in as ${readyClient.user.tag} (${readyClient.guilds.cache.size} guilds)`,
      );
      resolve();
    });
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore own messages
    if (message.author.id === botUserId) return;

    // Ignore other bots
    if (message.author.bot) return;

    const isDM = !message.guild;

    if (isDM) {
      if (!config.discord.allowDMs) return;
      await handleMessage(message, config);
      return;
    }

    // Guild message: check channel allowlist
    if (config.discord.allowedChannels.length > 0) {
      if (!config.discord.allowedChannels.includes(message.channelId)) return;
    }

    // Guild message: check mention gating
    if (config.discord.guildMode === "mention") {
      if (!botUserId || !message.mentions.has(botUserId)) return;
    }

    await handleMessage(message, config);
  });

  await client.login(config.discord.token);
  await ready;

  return client;
}

async function handleMessage(message: Message, config: Config): Promise<void> {
  // Strip bot mention from content for cleaner prompts
  let content = message.content;
  if (botUserId) {
    content = content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  }

  if (!content) return;

  try {
    const channel = message.channel;
    if (!channel.isSendable()) return;

    // Show typing indicator while LLM processes
    await channel.sendTyping();

    const reply = await getLLMResponse(message.channelId, content);
    const chunks = chunkMessage(reply);

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply({ content: chunks[i] });
      } else {
        await channel.send(chunks[i]);
      }
    }
  } catch (err) {
    console.error("Discord handler error:", err);
    try {
      await message.reply("Sorry, I encountered an error processing your message.");
    } catch {
      // If we can't even send the error message, just log it
    }
  }
}

/**
 * Send a message to a Discord channel by ID (used by cron module).
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
