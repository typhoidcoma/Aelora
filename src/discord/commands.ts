import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getLLMResponse } from "../llm.js";
import { getAllTools } from "../tool-registry.js";
import { buildResponseEmbed, buildErrorEmbed, buildToolListEmbed, buildSuccessEmbed } from "./embeds.js";
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

async function handleAsk(
  interaction: ChatInputCommandInteraction,
  model: string,
): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);

  await interaction.deferReply();

  try {
    const text = await getLLMResponse(interaction.channelId, prompt);

    const embeds = buildResponseEmbed(text, model);

    await interaction.editReply({ embeds: [embeds[0]] });

    for (let i = 1; i < embeds.length; i++) {
      await interaction.followUp({ embeds: [embeds[i]] });
    }
  } catch (err) {
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

async function handleReboot(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    embeds: [buildSuccessEmbed("Rebooting... I'll be back in a moment.")],
  });
  setTimeout(() => reboot(), 500);
}
