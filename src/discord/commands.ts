import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getLLMResponse, clearHistory } from "../llm.js";
import { getAllTools, executeTool } from "../tool-registry.js";
import { buildResponseEmbed, buildErrorEmbed, buildToolListEmbed, buildSuccessEmbed, buildStreamingEmbed } from "./embeds.js";
import { reboot } from "../lifecycle.js";

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
      .setName("clear")
      .setDescription("Clear conversation history for this channel"),

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
    case "clear":
      await handleClear(interaction);
      break;
    case "websearch":
      await handleWebSearch(interaction);
      break;
    case "reboot":
      await handleReboot(interaction);
      break;
    default:
      await interaction.reply({
        embeds: [buildErrorEmbed(`Unknown command: ${interaction.commandName}`)],
        ephemeral: true,
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

async function handleClear(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  clearHistory(interaction.channelId);
  await interaction.reply({
    embeds: [buildSuccessEmbed("Conversation history cleared for this channel.")],
    ephemeral: true,
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
