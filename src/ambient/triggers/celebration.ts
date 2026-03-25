import type { AmbientTrigger } from "../types.js";
import { getRecentMessages } from "../buffer.js";

const WIN_PATTERNS = /\b(shipped|deployed|merged|fixed|passed|finally|done|finished|completed|launched|released|promoted|accepted|approved|closed|resolved|nailed it|let's go|hell yeah|we did it)\b/i;

export const celebrationTrigger: AmbientTrigger = {
  name: "celebration",
  description: "Piles on the hype when someone shares a win",

  shouldEvaluate(buffer, config) {
    const windowMs = config.ambient.triggers.celebration.windowMinutes * 60 * 1000;
    const recent = getRecentMessages(buffer.channelId, windowMs);
    return recent.some((m) => WIN_PATTERNS.test(m.content));
  },

  async evaluate(ctx) {
    const windowMs = ctx.config.ambient.triggers.celebration.windowMinutes * 60 * 1000;
    const recent = getRecentMessages(ctx.buffer.channelId, windowMs);
    const winMessages = recent.filter((m) => WIN_PATTERNS.test(m.content));

    if (winMessages.length === 0) {
      return { message: null, debugReason: "no wins on re-check" };
    }

    const winContext = winMessages
      .map((m) => `${m.authorName}: ${m.content.slice(0, 300)}`)
      .join("\n");

    // surrounding context
    const surrounding = ctx.buffer.messages.slice(-10).map(
      (m) => `${m.authorName}: ${m.content.slice(0, 200)}`,
    ).join("\n");

    const prompt = `someone just shared what sounds like a win:

${winContext}

surrounding context:
${surrounding}

if this is a real win, hype them up. examples:
- "wait you actually finished it?? who are you"
- "oh it shipped?? i'm genuinely emotional rn"
- "finally. FINALLY."

if this isn't actually a win (sarcasm, someone else's thing, etc), respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      delayMs: 3000 + Math.random() * 12000, // 3-15 seconds
      replyToMessageId: winMessages[winMessages.length - 1].id,
      debugReason: `win detected from ${winMessages.map((m) => m.authorName).join(", ")}`,
    };
  },
};
