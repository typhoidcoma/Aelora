import { EmbedBuilder } from "discord.js";
import { fixMarkdownContinuity } from "../utils.js";

const ACCENT_COLOR = 0x5865f2; // Discord blurple
const ERROR_COLOR = 0xed4245; // Discord red
const SUCCESS_COLOR = 0x57f287; // Discord green
const EMBED_DESC_LIMIT = 4096;

let accentOverride: number | undefined;

export function setEmbedColor(color: number | undefined): void {
  accentOverride = color;
}

function accent(): number {
  return accentOverride ?? ACCENT_COLOR;
}

/** Build one or more embeds for an LLM response (splits at 4096 chars). */
export function buildResponseEmbed(
  text: string,
  model: string,
): EmbedBuilder[] {
  const chunks = chunkEmbedDescription(text);
  return chunks.map((chunk, i) => {
    const embed = new EmbedBuilder()
      .setDescription(chunk)
      .setColor(accent());

    if (i === chunks.length - 1) {
      embed.setFooter({ text: model });
      embed.setTimestamp();
    }

    return embed;
  });
}

/** Red embed for errors. */
export function buildErrorEmbed(errorMessage: string): EmbedBuilder {
  return new EmbedBuilder()
    .setDescription(errorMessage)
    .setColor(ERROR_COLOR)
    .setTimestamp();
}

/** Green embed for quick status (ping, etc.). */
export function buildSuccessEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder()
    .setDescription(text)
    .setColor(SUCCESS_COLOR)
    .setTimestamp();
}

/** Embed listing tools and agents with enabled/disabled status. */
export function buildToolListEmbed(
  tools: Array<{ name: string; description: string; enabled: boolean }>,
  agents: Array<{ name: string; description: string; enabled: boolean }>,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Available Tools & Agents")
    .setColor(accent())
    .setTimestamp();

  if (tools.length > 0) {
    const list = tools
      .map((t) => `${t.enabled ? "\u2705" : "\u274c"} **${t.name}** — ${t.description}`)
      .join("\n");
    embed.addFields({ name: "Tools", value: list.slice(0, 1024) });
  }

  if (agents.length > 0) {
    const list = agents
      .map((a) => `${a.enabled ? "\u2705" : "\u274c"} **${a.name}** — ${a.description}`)
      .join("\n");
    embed.addFields({ name: "Agents", value: list.slice(0, 1024) });
  }

  if (tools.length === 0 && agents.length === 0) {
    embed.setDescription("No tools or agents are currently loaded.");
  }

  return embed;
}

/** Partial embed for streaming display (no footer/timestamp). */
export function buildStreamingEmbed(partialText: string): EmbedBuilder {
  return new EmbedBuilder()
    .setDescription(partialText.slice(0, EMBED_DESC_LIMIT))
    .setColor(accent());
}

/** Split text to fit within the 4096-char embed description limit. */
export function chunkEmbedDescription(text: string): string[] {
  if (text.length <= EMBED_DESC_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= EMBED_DESC_LIMIT) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", EMBED_DESC_LIMIT);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", EMBED_DESC_LIMIT);
    if (splitAt <= 0) splitAt = EMBED_DESC_LIMIT;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return fixMarkdownContinuity(chunks);
}
