import type { AmbientTrigger, ContentPart } from "../types.js";
import { formatBufferForLLMMultimodal, getRecentMessages } from "../buffer.js";
import { extractUrlContent } from "../url-extract.js";

export const converseTrigger: AmbientTrigger = {
  name: "converse",
  description: "Participates naturally in active conversations when the bot has something genuine to add",

  shouldEvaluate(buffer, config) {
    const tc = config.ambient.triggers.converse;
    const windowMs = tc.windowMinutes * 60 * 1000;
    const recent = getRecentMessages(buffer.channelId, windowMs);
    const userMessages = recent.filter((m) => !m.isBot);
    if (userMessages.length < tc.minMessages) return false;

    const uniqueUsers = new Set(userMessages.map((m) => m.authorId));
    if (uniqueUsers.size < tc.minUsers) return false;

    // Don't evaluate if bot spoke in the last 5 messages
    const last5 = buffer.messages.slice(-5);
    if (last5.some((m) => m.isBot)) return false;

    return true;
  },

  async evaluate(ctx) {
    const tc = ctx.config.ambient.triggers.converse;
    const windowMs = tc.windowMinutes * 60 * 1000;
    const recent = getRecentMessages(ctx.buffer.channelId, windowMs);

    // Build multimodal conversation content (last 25 messages)
    const conversationParts = formatBufferForLLMMultimodal(ctx.buffer.channelId, 25);

    // Extract URL content from recent messages
    const recentMessages = recent.slice(-25);
    const urlContent = await extractUrlContent(recentMessages);
    let urlSection = "";
    if (urlContent.size > 0) {
      const entries = [...urlContent.entries()]
        .map(([url, content]) => `- ${url}: ${content.slice(0, 500)}`)
        .join("\n");
      urlSection = `\nsomeone shared these links:\n${entries}\n`;
    }

    const prompt: ContentPart[] = [
      ...conversationParts,
      {
        type: "text",
        text: `${urlSection}
good reasons to talk:
- something made you laugh or you have a good comeback
- you can riff on what someone said or take it somewhere unexpected
- someone shared something cool and you have a genuine reaction
- you know something relevant and it's actually interesting, not just "helpful"
- someone did something worth celebrating
- you want to tease someone (affectionately)
- an image or link is worth reacting to

bad reasons to talk:
- you'd be commenting on the conversation itself ("interesting discussion")
- you'd be narrating what happened
- you'd be repeating something [BOT] already said
- you'd be offering help nobody asked for
- you'd be giving a "fun fact" that reads like a wikipedia sidebar`,
      },
    ];

    const response = await ctx.llmEvaluate(prompt);
    const userCount = new Set(recent.filter((m) => !m.isBot).map((m) => m.authorId)).size;
    return {
      message: response,
      debugReason: `${recent.length} messages from ${userCount} users in #${ctx.buffer.channelName}`,
    };
  },
};
