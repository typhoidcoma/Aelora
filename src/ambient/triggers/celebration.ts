import type { AmbientTrigger } from "../types.js";
import { getRecentMessages } from "../buffer.js";

const WIN_PATTERNS = /\b(shipped|deployed|merged|fixed|passed|finally|done|finished|completed|launched|released|promoted|accepted|approved|closed|resolved|nailed it|let's go|hell yeah|we did it)\b/i;

export const celebrationTrigger: AmbientTrigger = {
  name: "celebration",
  description: "Piles on the hype when someone shares a win",

  shouldEvaluate(buffer) {
    // look for wins in the last 5 minutes
    const recent = getRecentMessages(buffer.channelId, 5 * 60 * 1000);
    return recent.some((m) => WIN_PATTERNS.test(m.content));
  },

  async evaluate(ctx) {
    const recent = getRecentMessages(ctx.buffer.channelId, 5 * 60 * 1000);
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

    const prompt = `someone in this discord channel just shared what sounds like a win:

${winContext}

surrounding context:
${surrounding}

if this is genuinely a win or accomplishment, write 1-2 sentences of enthusiastic hype. match or overshoot their energy. be genuinely excited. this is the "WAIT YOU ACTUALLY DID IT??" moment.

all lowercase. don't ask follow-up questions. just pure celebration energy.

if this isn't actually a win (sarcasm, talking about someone else, etc), respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      delayMs: 3000 + Math.random() * 12000, // 3-15 seconds
      replyToMessageId: winMessages[winMessages.length - 1].id,
      debugReason: `win detected from ${winMessages.map((m) => m.authorName).join(", ")}`,
    };
  },
};
