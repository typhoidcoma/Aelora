import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type ButtonInteraction,
} from "discord.js";
import type { Config } from "../config.js";
import { getLLMResponse } from "../llm.js";
import { chunkMessage } from "../utils.js";
import { processAttachments } from "./attachments.js";
import { setEmbedColor } from "./embeds.js";
import { getSlashCommandDefinitions, handleSlashCommand } from "./commands.js";
import { recordMessage } from "../sessions.js";
import { appendLog } from "../daily-log.js";
import { classifyMood, onMoodChange } from "../mood.js";
import { updateUser } from "../users.js";
import {
  detectOptions,
  buildOptionRow,
  buildDisabledRow,
  parseOptionCustomId,
} from "./options.js";
import { extractFacts, trackMessage } from "../fact-extractor.js";

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

  // --- Client lifecycle handlers ---
  client.on(Events.Error, (err) => {
    console.error("Discord client error:", err);
  });

  client.on(Events.Warn, (msg) => {
    console.warn("Discord client warning:", msg);
  });

  client.on("shardDisconnect", (event, shardId) => {
    console.warn(`Discord: shard ${shardId} disconnected (code ${event.code})`);
  });

  client.on("shardReconnecting", (shardId) => {
    console.log(`Discord: shard ${shardId} reconnecting...`);
  });

  client.on("shardResume", (shardId, replayedEvents) => {
    console.log(`Discord: shard ${shardId} resumed (${replayedEvents} events replayed)`);
  });

  const ready = new Promise<void>((resolve) => {
    client.once(Events.ClientReady, async (readyClient) => {
      botUserId = readyClient.user.id;
      discordClient = client;

      readyClient.user.setPresence({
        status: "online",
        activities: [{ name: config.discord.status, type: 3 }],
      });

      // Update Discord status when mood changes
      onMoodChange((emoji, label) => {
        readyClient.user.setPresence({
          status: "online",
          activities: [{ name: `${emoji} ${label}`, type: 3 }],
        });
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

  // --- Interaction handler (slash commands + option buttons) ---
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction, config.llm.model);
      } else if (interaction.isButton() && interaction.customId.startsWith("opt:")) {
        await handleOptionButton(interaction as ButtonInteraction, config);
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
  updateUser(message.author.id, message.author.displayName ?? message.author.username, message.channelId);
  trackMessage(message.channelId);

  const channel = message.channel;
  if (!channel.isSendable()) return;

  const preview = (content || "(attachment)").slice(0, 80) + ((content || "").length > 80 ? "..." : "");
  console.log(`Discord: message from ${message.author.username} in ${channelName}: "${preview}"`);

  let replyMsg: Message | null = null;
  let activeMsg: Message | null = null;
  let editTimer: ReturnType<typeof setInterval> | null = null;
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  try {
    // Keep typing indicator alive throughout response generation
    await channel.sendTyping();
    typingTimer = setInterval(() => {
      channel.sendTyping().catch((err) => console.warn("Discord: sendTyping failed:", err.message ?? err));
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
        }).catch((err) => { console.warn("Discord: failed to send streaming reply:", err.message ?? err); });
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

        const p = activeMsg.edit(pending.slice(0, splitAt)).catch((err) => { console.warn("Discord: failed to edit overflow message:", err.message ?? err); });
        inflightEdit = p;
        await p;
        activeOffset += splitAt;

        const overflow = buffer.slice(activeOffset);
        if (overflow.length > 0) {
          const p2 = channel.send(overflow + " \u25CF").then((msg) => {
            activeMsg = msg;
          }).catch((err) => { console.warn("Discord: failed to send overflow chunk:", err.message ?? err); });
          inflightEdit = p2;
          await p2;
        }
      } else {
        const p = activeMsg.edit(pending + " \u25CF").catch((err) => { console.warn("Discord: streaming edit failed:", err.message ?? err); });
        inflightEdit = p;
        await p;
      }
    };

    editTimer = setInterval(doEdit, STREAM_EDIT_INTERVAL);

    const llmStart = Date.now();
    const text = await getLLMResponse(message.channelId, userContent, (token) => {
      buffer += token;
    }, message.author.id);
    console.log(`Discord: LLM response ${Date.now() - llmStart}ms (${text.length} chars)`);

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
    } catch (err) { console.warn("Discord: daily log append failed:", err); }

    // Finalize: properly chunk the remaining text, detect option buttons
    const remaining = text.slice(activeOffset);
    const chunks = chunkMessage(remaining);

    const lastChunk = chunks[chunks.length - 1];
    const detectedOptions = detectOptions(lastChunk);
    const components = detectedOptions
      ? [buildOptionRow(detectedOptions, message.channelId, message.author.id)]
      : [];

    if (activeMsg) {
      if (chunks.length > 1) {
        await (activeMsg as Message).edit(chunks[0]);
        for (let i = 1; i < chunks.length - 1; i++) {
          await channel.send(chunks[i]);
        }
        // Last chunk gets the option buttons (if any)
        await channel.send({ content: lastChunk, components });
      } else {
        // Single chunk — edit in place with buttons
        await (activeMsg as Message).edit({ content: chunks[0], components });
      }
    } else {
      // No streaming content was sent yet — send final reply directly
      if (chunks.length === 1) {
        replyMsg = await message.reply({ content: chunks[0], components });
        activeMsg = replyMsg;
      } else {
        replyMsg = await message.reply(chunks[0]);
        activeMsg = replyMsg;
        for (let i = 1; i < chunks.length - 1; i++) {
          await channel.send(chunks[i]);
        }
        await channel.send({ content: lastChunk, components });
      }
    }

    console.log(`Discord: reply sent to ${channelName} (${chunks.length} chunk(s))`);

    // Auto-classify mood from the response (async, best-effort)
    const userText = typeof userContent === "string" ? userContent : content;
    classifyMood(text, userText).catch((err) => console.warn("Mood classify failed:", err));

    // Auto-extract facts from the conversation (async, best-effort)
    if (config.memory.autoExtract !== false) {
      extractFacts(userText, text, message.channelId, message.author.id)
        .catch((err) => console.warn("Fact extraction failed:", err));
    }
  } catch (err) {
    if (editTimer) clearInterval(editTimer);
    if (typingTimer) clearInterval(typingTimer);
    const errMsg = err instanceof Error ? err.message
      : typeof err === "object" && err !== null && "error" in err
        ? JSON.stringify((err as Record<string, unknown>).error)
        : String(err);
    console.error("Discord handler error:", errMsg);
    try {
      const short = errMsg.length > 200 ? errMsg.slice(0, 200) + "..." : errMsg;
      const errorTarget = activeMsg ?? replyMsg;
      if (errorTarget) {
        await errorTarget.edit(`Something went wrong: \`${short}\``);
      } else {
        await message.reply(`Something went wrong: \`${short}\``);
      }
    } catch (err) {
      console.warn("Discord: failed to send error message:", err);
    }
  }
}

// ── Option Button Handler ─────────────────────────────────

async function handleOptionButton(
  interaction: ButtonInteraction,
  config: Config,
): Promise<void> {
  const parsed = parseOptionCustomId(interaction.customId);
  if (!parsed) return;

  // Acknowledge within 3 seconds
  await interaction.deferUpdate();

  // Disable buttons on the clicked message (selected = green, rest = gray)
  const messageContent = interaction.message.content;
  const detectedOptions = detectOptions(messageContent);
  if (detectedOptions) {
    const disabledRow = buildDisabledRow(
      detectedOptions,
      parsed.channelId,
      parsed.userId,
      parsed.marker,
    );
    await interaction.editReply({ components: [disabledRow] });
  } else {
    await interaction.editReply({ components: [] });
  }

  const selectionText = `${parsed.marker}. ${parsed.label}`;
  const userId = interaction.user.id;
  const username = interaction.user.displayName ?? interaction.user.username;
  const channelName =
    interaction.channel && "name" in interaction.channel
      ? (interaction.channel.name as string)
      : "DM";

  console.log(`Discord: option button clicked by ${username} in ${channelName}: "${selectionText}"`);

  // Track side-effects
  recordMessage({
    channelId: parsed.channelId,
    guildId: interaction.guild?.id ?? null,
    channelName,
    userId,
    username,
  });
  updateUser(userId, username, parsed.channelId);
  trackMessage(parsed.channelId);

  // Stream a new LLM response into the channel
  const channel = interaction.channel;
  if (!channel || !channel.isSendable()) return;

  let activeMsg: Message | null = null;
  let buffer = "";
  let lastEditTime = 0;
  let streamDone = false;
  let inflightEdit: Promise<unknown> | null = null;

  const doEdit = async () => {
    if (streamDone) return;
    const pending = buffer;
    if (pending.length === 0) return;
    const now = Date.now();
    if (now - lastEditTime < STREAM_EDIT_INTERVAL) return;
    lastEditTime = now;

    if (!activeMsg) {
      const p = channel
        .send(pending + " \u25CF")
        .then((msg) => {
          activeMsg = msg;
        })
        .catch((err) => {
          console.warn("Discord: option reply send failed:", (err as Error).message ?? err);
        });
      inflightEdit = p;
      await p;
      return;
    }

    const p = (activeMsg as Message)
      .edit(pending + " \u25CF")
      .catch((err) => {
        console.warn("Discord: option reply edit failed:", (err as Error).message ?? err);
      });
    inflightEdit = p;
    await p;
  };

  const editTimer = setInterval(doEdit, STREAM_EDIT_INTERVAL);

  try {
    const text = await getLLMResponse(
      parsed.channelId,
      selectionText,
      (token) => {
        buffer += token;
      },
      userId,
    );

    streamDone = true;
    clearInterval(editTimer);
    if (inflightEdit) await inflightEdit;

    if (!text || text.trim().length === 0) {
      if (activeMsg) {
        await (activeMsg as Message).edit("_(no response)_");
      } else {
        await channel.send("_(no response)_");
      }
      return;
    }

    // Finalize with option detection on the new response
    const chunks = chunkMessage(text);
    const lastChunk = chunks[chunks.length - 1];
    const newOptions = detectOptions(lastChunk);
    const components = newOptions
      ? [buildOptionRow(newOptions, parsed.channelId, userId)]
      : [];

    if (activeMsg) {
      if (chunks.length > 1) {
        await (activeMsg as Message).edit(chunks[0]);
        for (let i = 1; i < chunks.length - 1; i++) {
          await channel.send(chunks[i]);
        }
        await channel.send({ content: lastChunk, components });
      } else {
        await (activeMsg as Message).edit({ content: chunks[0], components });
      }
    } else {
      if (chunks.length === 1) {
        await channel.send({ content: chunks[0], components });
      } else {
        await channel.send(chunks[0]);
        for (let i = 1; i < chunks.length - 1; i++) {
          await channel.send(chunks[i]);
        }
        await channel.send({ content: lastChunk, components });
      }
    }

    // Side-effects: daily log + mood (best-effort)
    try {
      appendLog({
        channelName,
        userId,
        username,
        summary: `**User (button):** ${selectionText.slice(0, 200)}\n**Bot:** ${text.slice(0, 200)}`,
      });
    } catch {
      /* best-effort */
    }
    classifyMood(text, selectionText).catch((err) =>
      console.warn("Mood classify failed:", err),
    );

    // Auto-extract facts (async, best-effort)
    if (config.memory.autoExtract !== false) {
      extractFacts(selectionText, text, parsed.channelId, userId)
        .catch((err) => console.warn("Fact extraction failed:", err));
    }
  } catch (err) {
    clearInterval(editTimer);
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Discord: option button handler error:", errMsg);
    try {
      if (activeMsg) {
        await (activeMsg as Message).edit(`Something went wrong: \`${errMsg.slice(0, 200)}\``);
      } else {
        await channel.send(`Something went wrong: \`${errMsg.slice(0, 200)}\``);
      }
    } catch {
      /* best-effort */
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
