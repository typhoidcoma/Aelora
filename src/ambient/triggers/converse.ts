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
you're part of this group. if you have something genuine to add, a thought, a reaction, something you know that's relevant, a real question, say it in 1-3 sentences. talk like you're IN the conversation.

what counts as adding:
- sharing something you know that's relevant to what's being discussed
- a genuine reaction to something someone said or shared
- building on someone's idea or asking a real question
- reacting to an image with actual engagement
- hyping a real win someone shared
- commenting on the actual content of a link someone shared

what doesn't count:
- commenting on the conversation itself ("the energy shifted", "this topic drifted")
- narrating what happened ("three people asked the same thing")
- meta-observations about group dynamics
- non sequiturs or random interjections
- repeating something tagged [BOT] already said

if you have nothing real to add, respond with exactly SKIP. most of the time you should SKIP.`,
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
