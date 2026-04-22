import {
  AttachmentBuilder,
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
import { classifyMood, onMoodChange } from "../mood.js";
import { updateUser } from "../users.js";
import { extractFacts, trackMessage } from "../fact-extractor.js";
import { saveFact } from "../memory.js";
import { triageUserMessage } from "../message-triage.js";
import { broadcastEvent } from "../logger.js";
import { ingestMessage, markReaction } from "../ambient/buffer.js";

export let discordClient: Client | null = null;
export let botUserId: string | null = null;

// Name-trigger cooldown: channelId → last chime-in timestamp
const nameChimeCooldown = new Map<string, number>();
const NAME_CHIME_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per channel
const NAME_CHIME_SKIP_CHANCE = 0.3; // 30% chance to stay quiet even if relevant

// Per-channel serialization. Two messages in the same channel must not race
// each other through `handleMessage` — without this, conversation history can
// interleave and the name-trigger 10–60s delay can launch concurrent LLM
// turns. Each call chains onto the previous one for the same channelId.
const channelLocks = new Map<string, Promise<unknown>>();
function withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = channelLocks.get(channelId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  channelLocks.set(
    channelId,
    next.finally(() => {
      if (channelLocks.get(channelId) === next) channelLocks.delete(channelId);
    }),
  );
  return next;
}

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
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Reaction, Partials.Message, Partials.User],
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

  client.on(Events.ChannelCreate, (channel) => {
    const guildName = "guild" in channel && channel.guild ? channel.guild.name : "unknown";
    const channelName = "name" in channel ? channel.name : (channel as any).id;
    console.log(`Discord: new channel created  -  #${channelName} (${channel.id}) in ${guildName}`);
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
            console.warn(`Discord: guild ${config.discord.guildId} not found in cache  -  commands not registered`);
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
    const isBotMessage = message.author.id === botUserId || message.author.bot;
    const isDM = !message.guild;

    // Ambient awareness: buffer ALL messages in allowed guild channels (including bot's own)
    if (!isDM && config.ambient.enabled) {
      const inAllowed = config.discord.allowedChannels.length === 0 || config.discord.allowedChannels.includes(message.channelId);
      if (inAllowed) {
        const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
        const chName = "name" in message.channel ? (message.channel.name as string) : "unknown";
        ingestMessage({
          id: message.id,
          channelId: message.channelId,
          channelName: chName,
          authorId: message.author.id,
          authorName: message.author.displayName ?? message.author.username,
          content: message.content,
          hasAttachments: message.attachments.size > 0,
          attachmentTypes: [...message.attachments.values()].map((a) => a.contentType ?? "unknown"),
          imageUrls: [...message.attachments.values()]
            .filter((a) => a.contentType && IMAGE_MIME.has(a.contentType) && a.url)
            .map((a) => a.url),
          isBot: isBotMessage,
        });
      }
    }

    // Stop processing bot messages (they're in the buffer but shouldn't trigger responses)
    if (isBotMessage) return;

    if (isDM) {
      if (!config.discord.allowDMs) return;
      await withChannelLock(message.channelId, () => handleMessage(message, config));
      return;
    }

    if (config.discord.allowedChannels.length > 0) {
      if (!config.discord.allowedChannels.includes(message.channelId)) return;
    }

    if (config.discord.guildMode === "mention") {
      const mentioned = botUserId && message.mentions.has(botUserId);
      const botName = config.persona.botName.toLowerCase();
      const namedInText = message.content.toLowerCase().includes(botName);
      if (!mentioned && !namedInText) return;
      // Name-triggered (not @mentioned) — natural chime-in behavior
      if (!mentioned && namedInText) {
        // Respect shared engagement lock (prevents cascading with ambient/reply-check)
        const { canEngage: canEngageChannel, recordEngagement } = await import("../ambient/engagement.js");
        if (!canEngageChannel(message.channelId, 15 * 60 * 1000)) return;

        // Cooldown: don't chime in if we already did recently in this channel
        const lastChime = nameChimeCooldown.get(message.channelId) ?? 0;
        if (Date.now() - lastChime < NAME_CHIME_COOLDOWN_MS) return;

        // Random skip: 30% of the time, just stay quiet
        if (Math.random() < NAME_CHIME_SKIP_CHANCE) return;

        // Stamp the cooldown BEFORE the delay so any concurrent name-triggers
        // arriving during the delay window see it and bail. This is the
        // mutex-light protection against the name-trigger race.
        nameChimeCooldown.set(message.channelId, Date.now());

        // Random delay before doing anything (no typing indicator yet)
        const delayMs = 10000 + Math.random() * 50000; // 10-60 seconds
        await new Promise((r) => setTimeout(r, delayMs));

        // Fetch recent messages for context so she can decide if chiming in makes sense
        let recentContext = "";
        try {
          const recent = await message.channel.messages.fetch({ limit: 6, before: message.id });
          const lines = [...recent.values()]
            .reverse()
            .map((m) => `${m.author.displayName ?? m.author.username}: ${m.content.slice(0, 200)}`);
          if (lines.length > 0) recentContext = lines.join("\n");
        } catch { /* no permission or error, proceed without context */ }

        recordEngagement(message.channelId, "name-triggered");
        await withChannelLock(message.channelId, () =>
          handleMessage(message, config, true, recentContext),
        );
        return;
      }
    }

    // Direct @mention — always respond, record engagement
    const { recordEngagement } = await import("../ambient/engagement.js");
    recordEngagement(message.channelId, "mention");
    await withChannelLock(message.channelId, () => handleMessage(message, config));
  });

  // --- Interaction handler (slash commands) ---
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction, config.llm.model);
      }
    } catch (err: unknown) {
      // Interaction expired (10062) or already acknowledged (40060)  -  not a crash
      const code = (err as { code?: number }).code;
      if (code === 10062 || code === 40060) {
        console.warn(`Discord: interaction expired or already acked (code ${code})`);
        return;
      }
      console.error("Discord: interaction handler error:", err);
    }
  });

  // --- Reaction detection ---

  const POSITIVE_EMOJI = new Set(["👍", "❤️", "✅", "🔥", "💯", "⭐", "🎉", "💪", "👏", "🙌", "😍", "🤩", "💜", "💙", "🫡", "🙏"]);
  const NEGATIVE_EMOJI = new Set(["👎", "❌", "😒", "😡", "🤮", "💀"]);
  const reactionThrottle = new Map<string, number>(); // userId → last saved timestamp
  const REACTION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per user

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (user.bot || user.id === client.user?.id) return;

      // Resolve partials
      if (reaction.partial) reaction = await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const emoji = reaction.emoji.name ?? "unknown";
      const channelName = "name" in reaction.message.channel ? (reaction.message.channel as any).name : reaction.message.channelId;
      const username = (user as any).username ?? user.id;

      console.log(`Discord: ${username} reacted ${emoji} to message in #${channelName}`);

      // Ambient: track reactions for cursed-image trigger
      markReaction(reaction.message.id, reaction.message.channelId);

      broadcastEvent("mindmap", {
        type: "reaction:added",
        conversationId: reaction.message.channelId,
        userId: user.id,
        emoji,
        botMessage: reaction.message.author?.id === client.user?.id,
        timestamp: new Date().toISOString(),
      });

      // Only save facts for reactions to bot messages with clear sentiment
      if (reaction.message.author?.id !== client.user?.id) return;

      const isPositive = POSITIVE_EMOJI.has(emoji);
      const isNegative = NEGATIVE_EMOJI.has(emoji);
      if (!isPositive && !isNegative) return;

      // Throttle: max 1 fact per user per 5 minutes
      const lastSaved = reactionThrottle.get(user.id) ?? 0;
      if (Date.now() - lastSaved < REACTION_COOLDOWN_MS) return;
      reactionThrottle.set(user.id, Date.now());

      const preview = (reaction.message.content ?? "").slice(0, 80);
      const fact = isPositive
        ? `Reacted positively (${emoji}) to bot's message: "${preview}"`
        : `Disagreed (${emoji}) with bot's message: "${preview}"`;

      saveFact(`user:${user.id}`, fact, {
        category: "behavioral",
        confidence: "inferred",
        source: `reaction:${reaction.message.channelId}`,
      });
    } catch (err) {
      console.warn("Discord: reaction handler error:", err);
    }
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.partial) reaction = await reaction.fetch();
      const emoji = reaction.emoji.name ?? "unknown";
      const username = (user as any).username ?? user.id;
      const channelName = "name" in reaction.message.channel ? (reaction.message.channel as any).name : reaction.message.channelId;
      console.log(`Discord: ${username} removed ${emoji} reaction in #${channelName}`);
    } catch {
      // best effort
    }
  });

  await client.login(config.discord.token);
  await ready;

  return client;
}

const STREAM_EDIT_INTERVAL = 1200;
const TYPING_INTERVAL = 8_000;
const OVERFLOW_THRESHOLD = 1800;

async function handleMessage(message: Message, config: Config, nameTriggered = false, recentContext = ""): Promise<void> {
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

  // Fire-and-forget pre-response triage (extracts dates, entities, sentiment before LLM responds)
  if (config.memory.triageEnabled !== false && content) {
    triageUserMessage(content, message.channelId).catch(() => {});
  }

  const channel = message.channel;
  if (!channel.isSendable()) return;

  const preview = (content || "(attachment)").slice(0, 80) + ((content || "").length > 80 ? "..." : "");
  console.log(`Discord: message from ${message.author.username} in ${channelName}: "${preview}"`);

  let replyMsg: Message | null = null;
  let activeMsg: Message | null = null;
  let editTimer: ReturnType<typeof setInterval> | null = null;
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  // Diagnostic trace — catches silent hangs between Discord msg log and LLM response.
  // Remove or raise the threshold once stability is confirmed.
  const handleStart = Date.now();
  const stageTrace = (stage: string) => console.log(`Discord: [${message.author.username}] +${Date.now() - handleStart}ms ${stage}`);

  try {
    // If name-triggered (not @mentioned), give context and let LLM decide whether to reply
    if (nameTriggered) {
      const contextBlock = recentContext ? `\n\nRecent conversation for context:\n${recentContext}\n` : "";
      content = `[Your name was mentioned in conversation but you were NOT directly @mentioned. Read the recent context and the message below. If it makes sense for you to chime in (someone's talking about you, asking about you, or you have something genuinely useful or fun to add), respond naturally in 1-3 sentences. Use any tools you need. If there's no reason for you to respond, reply with exactly "SKIP_REPLY" and nothing else.]${contextBlock}\n${content}`;
      // Delay typing indicator so it doesn't telegraph "bot is about to respond" instantly
      const typingDelay = 1000 + Math.random() * 3000; // 1-4 seconds after the main delay
      await new Promise((r) => setTimeout(r, typingDelay));
    }

    // Keep typing indicator alive throughout response generation
    stageTrace("before sendTyping");
    await channel.sendTyping();
    stageTrace("after sendTyping");
    typingTimer = setInterval(() => {
      channel.sendTyping().catch((err) => console.warn("Discord: sendTyping failed:", err.message ?? err));
    }, TYPING_INTERVAL);
    const userContent = await processAttachments(message, content, config.llm.model);
    stageTrace("after processAttachments");

    // Streaming state  -  no placeholder reply; typing indicator covers the wait
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
        // First content  -  name-triggered sends as regular message, otherwise reply
        const sendFn = nameTriggered
          ? channel.send(pending + " \u25CF")
          : message.reply(pending + " \u25CF");
        const p = sendFn.then((msg) => {
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

    stageTrace("calling getLLMResponse");
    const llmStart = Date.now();
    // Hard timeout: a hung LLM call must not wedge the channel lock forever.
    // 180s covers tool loops + slow models; anything past that is a real hang.
    const LLM_TIMEOUT_MS = 180_000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`LLM call timed out after ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS);
    });
    const text = await Promise.race([
      getLLMResponse(message.channelId, userContent, (token) => {
      buffer += token;
    }, message.author.id, async (toolNames) => {
      // Tools are about to run - show a clean status instead of partial streaming text
      const label = toolNames.length === 1 ? toolNames[0] : toolNames.join(", ");
      const statusText = `_Working on it (${label})..._`;
      try {
        if (activeMsg) {
          await (activeMsg as Message).edit(statusText);
        } else {
          activeMsg = await message.reply(statusText);
          replyMsg = activeMsg;
        }
      } catch (err) {
        console.warn("Discord: failed to send tool status:", (err as Error).message ?? err);
      }
      // Reset buffer so the final LLM response starts fresh
      buffer = "";
      activeOffset = 0;
    }),
      timeoutPromise,
    ]);
    console.log(`Discord: LLM response ${Date.now() - llmStart}ms (${text.length} chars)`);

    // Stop streaming edits and wait for any in-flight Discord API call to settle
    streamDone = true;
    clearInterval(editTimer);
    editTimer = null;
    if (inflightEdit) await inflightEdit;
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }

    // Name-triggered: if LLM decided not to chime in, silently bail and reset cooldown
    if (nameTriggered && text.trim().replace(/[^a-zA-Z_]/g, "") === "SKIP_REPLY") {
      if (activeMsg) await (activeMsg as Message).delete().catch(() => {});
      nameChimeCooldown.delete(message.channelId); // don't eat cooldown for a skip
      return;
    }

    if (!text || text.trim().length === 0) {
      if (nameTriggered) {
        // Don't send "no response" for name-triggered messages, just stay quiet
        if (activeMsg) await (activeMsg as Message).delete().catch(() => {});
        nameChimeCooldown.delete(message.channelId);
        return;
      }
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

    // Finalize: properly chunk the remaining text
    const remaining = text.slice(activeOffset);
    const chunks = chunkMessage(remaining);

    const lastChunk = chunks[chunks.length - 1];

    if (activeMsg) {
      if (chunks.length > 1) {
        await (activeMsg as Message).edit(chunks[0]);
        for (let i = 1; i < chunks.length - 1; i++) {
          await channel.send(chunks[i]);
        }
        await channel.send(lastChunk);
      } else {
        await (activeMsg as Message).edit(chunks[0]);
      }
    } else {
      // No streaming content was sent yet  -  send final reply directly
      // Name-triggered: send as regular message, not a reply
      const sendFirst = nameTriggered
        ? (text: string) => channel.send(text)
        : (text: string) => message.reply(text);
      if (chunks.length === 1) {
        replyMsg = await sendFirst(chunks[0]);
        activeMsg = replyMsg;
      } else {
        replyMsg = await sendFirst(chunks[0]);
        activeMsg = replyMsg;
        for (let i = 1; i < chunks.length - 1; i++) {
          await channel.send(chunks[i]);
        }
        await channel.send(lastChunk);
      }
    }

    console.log(`Discord: reply sent to ${channelName} (${chunks.length} chunk(s))`);

    // Auto-classify mood from the response (async, best-effort)
    const userText = typeof userContent === "string" ? userContent : content;
    classifyMood(text, userText, message.channelId).catch((err) => console.warn("Mood classify failed:", err));

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

/**
 * Send a file (e.g. generated image) to a Discord channel as an attachment.
 */
export async function sendFileToChannel(
  channelId: string,
  file: Buffer,
  filename: string,
): Promise<void> {
  if (!discordClient) throw new Error("Discord client not connected");

  const channel = await discordClient.channels.fetch(channelId);
  if (!channel || !channel.isSendable()) {
    throw new Error(`Channel ${channelId} is not a text channel`);
  }

  const attachment = new AttachmentBuilder(file, { name: filename });
  await channel.send({ files: [attachment] });
}
