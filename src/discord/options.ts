import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

const MAX_CUSTOM_ID = 100;
const MAX_BUTTON_LABEL = 80;
const MAX_OPTION_LINE_LEN = 150;
const MAX_TRAILING_LINES = 2; // non-option lines allowed after the option block

export type DetectedOption = {
  marker: string; // "1", "A", auto-number for bullets/named
  label: string; // Button display text
};

export type ParsedOption = {
  channelId: string;
  userId: string;
  marker: string;
  label: string;
};

// ── Option-line patterns (ordered strictest → loosest) ────

type OptionType = "numbered" | "lettered" | "bullet" | "bold" | "named";

type OptionMatch = {
  type: OptionType;
  option: DetectedOption;
};

function matchOptionLine(line: string): OptionMatch | null {
  if (line.length > MAX_OPTION_LINE_LEN) return null;
  let m;

  // 1. Numbered: "1. text" or "1) text"
  m = line.match(/^[ \t]*(\d{1,2})[.)]\s+(.+)$/);
  if (m) return { type: "numbered", option: { marker: m[1], label: m[2].trim() } };

  // 2. Lettered: "A. text" or "a) text"
  m = line.match(/^[ \t]*([a-zA-Z])[.)]\s+(.+)$/);
  if (m) return { type: "lettered", option: { marker: m[1], label: m[2].trim() } };

  // 3. Bullet: "- text", "* text", "• text"
  m = line.match(/^[ \t]*[-*•]\s+(.+)$/);
  if (m) return { type: "bullet", option: { marker: "", label: m[1].trim() } };

  // 4. Bold label: "**Name**: desc" or "**Name** - desc"
  m = line.match(/^\*\*([^*]{1,50})\*\*\s*[-:–—]\s*(.+)$/);
  if (m) return { type: "bold", option: { marker: "", label: m[1].trim() } };

  // 5. Named: "Name: Description" (capitalized, 1-6 word name)
  m = line.match(/^([A-Z][^:]{0,49}):\s+(.+)$/);
  if (m) {
    const name = m[1].trim();
    if (name.split(/\s+/).length <= 6) {
      return { type: "named", option: { marker: "", label: name } };
    }
  }

  return null;
}

// ── Detection ─────────────────────────────────────────────

/**
 * Detect option lists near the end of an LLM response.
 * Returns null if no valid option block is found.
 *
 * Supported formats:
 * - Numbered:  "1. text", "2) text"
 * - Lettered:  "A. text", "b) text"
 * - Bullet:    "- text", "* text", "• text"
 * - Bold:      "**Name**: description", "**Name** - description"
 * - Named:     "Name: Description" (capitalized, short name)
 *
 * Rules:
 * - 2-5 consecutive option lines, all the same format type
 * - Up to 2 trailing non-option lines are skipped (e.g. "Pick one!")
 * - Blank lines between prose and the option block are allowed
 */
export function detectOptions(text: string): DetectedOption[] | null {
  const lines = text.trimEnd().split("\n");
  let i = lines.length - 1;
  let tailLines = 0;
  let foundOptionBlock = false;
  const options: DetectedOption[] = [];
  let detectedType: OptionType | null = null;

  for (; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      // Blank line: if we already have options, this ends the block
      if (foundOptionBlock) break;
      continue; // skip trailing blanks
    }

    const parsed = matchOptionLine(line);

    if (parsed) {
      // Enforce format consistency within the block
      if (detectedType === null) {
        detectedType = parsed.type;
      } else if (parsed.type !== detectedType) {
        break;
      }
      foundOptionBlock = true;
      options.unshift(parsed.option);
    } else {
      // Non-option line: allow up to MAX_TRAILING_LINES after the option block
      if (!foundOptionBlock && tailLines < MAX_TRAILING_LINES) {
        tailLines++;
        continue;
      }
      break;
    }
  }

  if (options.length < 2 || options.length > 5) return null;

  // Auto-number markers for formats without inherent markers
  if (detectedType && !["numbered", "lettered"].includes(detectedType)) {
    options.forEach((opt, idx) => {
      opt.marker = String(idx + 1);
    });
  }

  return options;
}

// ── Button Builders ───────────────────────────────────────

/**
 * Build a Discord ActionRow with one Primary (blue) button per option.
 */
export function buildOptionRow(
  options: DetectedOption[],
  channelId: string,
  userId: string,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const opt of options) {
    const customId = buildCustomId(channelId, userId, opt.marker, opt.label);
    const label =
      opt.label.length > MAX_BUTTON_LABEL
        ? opt.label.slice(0, MAX_BUTTON_LABEL - 3) + "..."
        : opt.label;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(ButtonStyle.Primary),
    );
  }
  return row;
}

/**
 * Build a disabled version of the option row (for after a button is clicked).
 * Selected button is green (Success), others are gray (Secondary).
 */
export function buildDisabledRow(
  options: DetectedOption[],
  channelId: string,
  userId: string,
  selectedMarker: string,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const opt of options) {
    const customId = buildCustomId(channelId, userId, opt.marker, opt.label);
    const label =
      opt.label.length > MAX_BUTTON_LABEL
        ? opt.label.slice(0, MAX_BUTTON_LABEL - 3) + "..."
        : opt.label;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(opt.marker === selectedMarker ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(true),
    );
  }
  return row;
}

// ── CustomId Encoding ─────────────────────────────────────

function buildCustomId(
  channelId: string,
  userId: string,
  marker: string,
  label: string,
): string {
  const base = `opt:${channelId}:${userId}:${marker}:`;
  const maxLabel = MAX_CUSTOM_ID - base.length;
  return base + label.slice(0, Math.max(0, maxLabel));
}

/**
 * Parse a button customId back into its components.
 * Returns null if this customId is not an option button.
 */
export function parseOptionCustomId(customId: string): ParsedOption | null {
  if (!customId.startsWith("opt:")) return null;
  const rest = customId.slice(4); // remove "opt:"

  // Format: channelId:userId:marker:label
  // channelId and userId are numeric snowflakes (no colons)
  const firstColon = rest.indexOf(":");
  if (firstColon === -1) return null;
  const channelId = rest.slice(0, firstColon);

  const rest1 = rest.slice(firstColon + 1);
  const secondColon = rest1.indexOf(":");
  if (secondColon === -1) return null;
  const userId = rest1.slice(0, secondColon);

  const rest2 = rest1.slice(secondColon + 1);
  const thirdColon = rest2.indexOf(":");
  if (thirdColon === -1) return null;
  const marker = rest2.slice(0, thirdColon);
  const label = rest2.slice(thirdColon + 1);

  if (!channelId || !userId || !marker) return null;
  return { channelId, userId, marker, label };
}
