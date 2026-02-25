import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getLLMResponse, clearSession } from "../llm.js";
import { deleteSession } from "../sessions.js";
import { getAllTools, executeTool } from "../tool-registry.js";
import { buildResponseEmbed, buildErrorEmbed, buildToolListEmbed, buildSuccessEmbed, buildStreamingEmbed } from "./embeds.js";
import { reboot } from "../lifecycle.js";
import { saveFact, getFacts, clearScope } from "../memory.js";
import { loadMood, resolveLabel } from "../mood.js";
import { listNotesByScope, getNote, upsertNote, deleteNote } from "../tools/notes.js";

// Lazy import to avoid circular dep (agent-registry imports from discord barrel)
let agentRegistryCache: typeof import("../agent-registry.js") | null = null;

async function getAgentRegistry() {
  if (!agentRegistryCache) {
    try {
      agentRegistryCache = await import("../agent-registry.js");
    } catch {
      // Agents might not be loaded
    }
  }
  return agentRegistryCache;
}

export function getSlashCommandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Ask the bot a question or give it a prompt")
      .addStringOption((opt) =>
        opt
          .setName("prompt")
          .setDescription("Your question or prompt")
          .setRequired(true),
      ),

    new SlashCommandBuilder()
      .setName("tools")
      .setDescription("List currently available tools and agents"),

    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Check if the bot is responsive"),

    new SlashCommandBuilder()
      .setName("new")
      .setDescription("Start a fresh session — clears history, summary, and context"),

    new SlashCommandBuilder()
      .setName("websearch")
      .setDescription("Search the web using Brave Search")
      .addStringOption((opt) =>
        opt
          .setName("query")
          .setDescription("What to search for")
          .setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName("count")
          .setDescription("Number of results (1-10, default 5)")
          .setMinValue(1)
          .setMaxValue(10),
      ),

    new SlashCommandBuilder()
      .setName("reboot")
      .setDescription("Restart the bot process"),

    new SlashCommandBuilder()
      .setName("play")
      .setDescription("Launch the Activity in this channel"),

    new SlashCommandBuilder()
      .setName("memory")
      .setDescription("View or manage your memory facts")
      .addSubcommand((sub) =>
        sub.setName("view").setDescription("View your remembered facts"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Remember a fact about you")
          .addStringOption((opt) =>
            opt.setName("fact").setDescription("The fact to remember").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub.setName("clear").setDescription("Clear all your remembered facts"),
      ),

    new SlashCommandBuilder()
      .setName("mood")
      .setDescription("Show the bot's current mood"),

    new SlashCommandBuilder()
      .setName("note")
      .setDescription("Manage notes")
      .addSubcommand((sub) =>
        sub
          .setName("list")
          .setDescription("List notes in a scope")
          .addStringOption((opt) =>
            opt.setName("scope").setDescription("Scope (e.g. global, channel:123)").setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("get")
          .setDescription("Read a note")
          .addStringOption((opt) => opt.setName("scope").setDescription("Scope").setRequired(true))
          .addStringOption((opt) => opt.setName("title").setDescription("Note title").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("save")
          .setDescription("Create or update a note")
          .addStringOption((opt) => opt.setName("scope").setDescription("Scope").setRequired(true))
          .addStringOption((opt) => opt.setName("title").setDescription("Note title").setRequired(true))
          .addStringOption((opt) => opt.setName("content").setDescription("Note content").setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName("delete")
          .setDescription("Delete a note")
          .addStringOption((opt) => opt.setName("scope").setDescription("Scope").setRequired(true))
          .addStringOption((opt) => opt.setName("title").setDescription("Note title").setRequired(true)),
      ),

    new SlashCommandBuilder()
      .setName("help")
      .setDescription("List all available bot commands"),
  ];
}

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  model: string,
): Promise<void> {
  switch (interaction.commandName) {
    case "ask":
      await handleAsk(interaction, model);
      break;
    case "tools":
      await handleTools(interaction);
      break;
    case "ping":
      await handlePing(interaction);
      break;
    case "new":
      await handleNew(interaction);
      break;
    case "websearch":
      await handleWebSearch(interaction);
      break;
    case "reboot":
      await handleReboot(interaction);
      break;
    case "play":
      await handlePlay(interaction);
      break;
    case "memory":
      await handleMemory(interaction);
      break;
    case "mood":
      await handleMood(interaction);
      break;
    case "note":
      await handleNote(interaction);
      break;
    case "help":
      await handleHelp(interaction);
      break;
    default:
      await interaction.reply({
        embeds: [buildErrorEmbed(`Unknown command: ${interaction.commandName}`)],
        flags: MessageFlags.Ephemeral,
      });
  }
}

const STREAM_EDIT_INTERVAL = 1500;

async function handleAsk(
  interaction: ChatInputCommandInteraction,
  model: string,
): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);

  await interaction.deferReply();

  let buffer = "";
  let lastEditTime = 0;
  let editTimer: ReturnType<typeof setInterval> | null = null;

  const doEdit = async () => {
    if (buffer.length === 0) return;
    const now = Date.now();
    if (now - lastEditTime < STREAM_EDIT_INTERVAL) return;
    lastEditTime = now;

    let display = buffer;
    if (display.length > 4090) {
      display = display.slice(0, 4090) + "\u2026";
    } else {
      display += " \u25CF";
    }

    try {
      await interaction.editReply({ embeds: [buildStreamingEmbed(display)] });
    } catch { /* interaction expired */ }
  };

  try {
    editTimer = setInterval(doEdit, STREAM_EDIT_INTERVAL);

    const text = await getLLMResponse(interaction.channelId, prompt, (token) => {
      buffer += token;
    });

    clearInterval(editTimer);
    editTimer = null;

    const embeds = buildResponseEmbed(text, model);
    await interaction.editReply({ embeds: [embeds[0]] });

    for (let i = 1; i < embeds.length; i++) {
      await interaction.followUp({ embeds: [embeds[i]] });
    }
  } catch (err) {
    if (editTimer) clearInterval(editTimer);
    console.error("Slash /ask error:", err);
    await interaction.editReply({
      embeds: [buildErrorEmbed("Sorry, I encountered an error processing your request.")],
    });
  }
}

async function handleTools(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const tools = getAllTools();
  const agentReg = await getAgentRegistry();
  const agents = agentReg ? agentReg.getAllAgents() : [];
  const embed = buildToolListEmbed(tools, agents);
  await interaction.reply({ embeds: [embed] });
}

async function handlePing(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const latency = Date.now() - interaction.createdTimestamp;
  await interaction.reply({
    embeds: [buildSuccessEmbed(`Pong! Latency: **${latency}ms**`)],
  });
}

async function handleNew(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  clearSession(interaction.channelId);
  deleteSession(interaction.channelId);
  await interaction.reply({
    embeds: [buildSuccessEmbed("New session started — history, summary, and context cleared.")],
  });
}

async function handleWebSearch(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const query = interaction.options.getString("query", true);
  const count = interaction.options.getInteger("count") ?? 5;

  await interaction.deferReply();

  try {
    const result = await executeTool("web_search", { query, count }, interaction.channelId);

    const embeds = buildResponseEmbed(result, "Brave Search");

    await interaction.editReply({ embeds: [embeds[0]] });

    for (let i = 1; i < embeds.length; i++) {
      await interaction.followUp({ embeds: [embeds[i]] });
    }
  } catch (err) {
    console.error("Slash /websearch error:", err);
    await interaction.editReply({
      embeds: [buildErrorEmbed("Search failed. Check that Brave API key is configured.")],
    });
  }
}

async function handleReboot(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    embeds: [buildSuccessEmbed("Rebooting... I'll be back in a moment.")],
  });
  setTimeout(() => reboot(), 500);
}

async function handlePlay(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const applicationId = interaction.client.application?.id;

  if (!applicationId) {
    await interaction.reply({
      embeds: [buildErrorEmbed("Activity not available: could not determine application ID.")],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const activityUrl = `https://discord.com/activities/${applicationId}`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Launch Activity")
      .setStyle(ButtonStyle.Link)
      .setURL(activityUrl),
  );

  const embed = new EmbedBuilder()
    .setTitle("Launch Activity")
    .setDescription("Click the button below to launch the Activity!")
    .setColor(0xa78bfa)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    components: [row],
  });
}

async function handleMemory(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const scope = `user:${interaction.user.id}`;

  switch (sub) {
    case "view": {
      const facts = getFacts(scope);
      if (facts.length === 0) {
        await interaction.reply({
          embeds: [buildSuccessEmbed("No facts remembered about you yet.")],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const list = facts.map((f, i) => `${i + 1}. ${f.fact}`).join("\n");
      const embed = new EmbedBuilder()
        .setTitle("Your Memory Facts")
        .setDescription(list.slice(0, 4090))
        .setColor(0xa78bfa)
        .setFooter({ text: `${facts.length} fact(s)` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      break;
    }
    case "add": {
      const fact = interaction.options.getString("fact", true);
      const result = saveFact(scope, fact);
      if (result.success) {
        await interaction.reply({
          embeds: [buildSuccessEmbed(`Remembered: "${fact}"`)],
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          embeds: [buildErrorEmbed(result.error ?? "Failed to save fact")],
          flags: MessageFlags.Ephemeral,
        });
      }
      break;
    }
    case "clear": {
      const count = clearScope(scope);
      await interaction.reply({
        embeds: [buildSuccessEmbed(`Cleared ${count} fact(s) about you.`)],
        flags: MessageFlags.Ephemeral,
      });
      break;
    }
  }
}

async function handleMood(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const mood = loadMood();
  if (!mood) {
    await interaction.reply({
      embeds: [buildSuccessEmbed("No mood data yet — I haven't had any conversations recently.")],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const MOOD_COLORS: Record<string, number> = {
    joy: 0xf2c572, trust: 0x8bc58b, fear: 0x9b7fbf, surprise: 0x5fbfbf,
    sadness: 0x6a8cb7, disgust: 0x8b8b6a, anger: 0xc56a6a, anticipation: 0xd4a056,
  };

  const label = resolveLabel(mood);
  const secondary = mood.secondary ? ` + ${mood.secondary}` : "";
  const color = MOOD_COLORS[mood.emotion] ?? 0xa78bfa;

  const embed = new EmbedBuilder()
    .setTitle("Current Mood")
    .setDescription(
      `**${label.charAt(0).toUpperCase() + label.slice(1)}${secondary}**\n` +
      `Emotion: ${mood.emotion} (intensity ${mood.intensity}/10)\n` +
      (mood.note ? `Note: ${mood.note}` : ""),
    )
    .setColor(color)
    .setFooter({ text: `Updated ${new Date(mood.updatedAt).toLocaleString()}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleNote(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const scope = interaction.options.getString("scope", true);

  switch (sub) {
    case "list": {
      const notes = listNotesByScope(scope);
      const titles = Object.keys(notes);
      if (titles.length === 0) {
        await interaction.reply({
          embeds: [buildSuccessEmbed(`No notes in scope "${scope}".`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const list = titles.map((t) => `- **${t}** (updated ${new Date(notes[t].updatedAt).toLocaleDateString()})`).join("\n");
      const embed = new EmbedBuilder()
        .setTitle(`Notes: ${scope}`)
        .setDescription(list.slice(0, 4090))
        .setColor(0xa78bfa)
        .setFooter({ text: `${titles.length} note(s)` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      break;
    }
    case "get": {
      const title = interaction.options.getString("title", true);
      const note = getNote(scope, title);
      if (!note) {
        await interaction.reply({
          embeds: [buildErrorEmbed(`Note "${title}" not found in scope "${scope}".`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle(`${scope} / ${title}`)
        .setDescription(note.content.slice(0, 4090))
        .setColor(0xa78bfa)
        .setFooter({ text: `Updated ${new Date(note.updatedAt).toLocaleDateString()}` })
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      break;
    }
    case "save": {
      const title = interaction.options.getString("title", true);
      const content = interaction.options.getString("content", true);
      upsertNote(scope, title, content);
      await interaction.reply({
        embeds: [buildSuccessEmbed(`Note "${title}" saved in scope "${scope}".`)],
        flags: MessageFlags.Ephemeral,
      });
      break;
    }
    case "delete": {
      const title = interaction.options.getString("title", true);
      const deleted = deleteNote(scope, title);
      if (deleted) {
        await interaction.reply({
          embeds: [buildSuccessEmbed(`Note "${title}" deleted from scope "${scope}".`)],
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          embeds: [buildErrorEmbed(`Note "${title}" not found in scope "${scope}".`)],
          flags: MessageFlags.Ephemeral,
        });
      }
      break;
    }
  }
}

async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const commands = [
    { name: "/ask", desc: "Ask the bot a question or give it a prompt" },
    { name: "/tools", desc: "List available tools and agents" },
    { name: "/ping", desc: "Check if the bot is responsive" },
    { name: "/new", desc: "Start a fresh session — clears history, summary, and context" },
    { name: "/websearch", desc: "Search the web using Brave Search" },
    { name: "/memory view", desc: "View your remembered facts" },
    { name: "/memory add", desc: "Remember a fact about you" },
    { name: "/memory clear", desc: "Clear all your remembered facts" },
    { name: "/mood", desc: "Show the bot's current mood" },
    { name: "/note list", desc: "List notes in a scope" },
    { name: "/note get", desc: "Read a note" },
    { name: "/note save", desc: "Create or update a note" },
    { name: "/note delete", desc: "Delete a note" },
    { name: "/play", desc: "Launch the Activity in this channel" },
    { name: "/reboot", desc: "Restart the bot process" },
    { name: "/help", desc: "Show this help message" },
  ];

  const list = commands.map((c) => `**${c.name}** — ${c.desc}`).join("\n");

  const embed = new EmbedBuilder()
    .setTitle("Available Commands")
    .setDescription(list)
    .setColor(0xa78bfa)
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
