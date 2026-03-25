import type { AmbientTrigger, ContentPart } from "../types.js";
import { formatBufferForLLMMultimodal } from "../buffer.js";

export const patternCalloutTrigger: AmbientTrigger = {
  name: "pattern-callout",
  description: "Notices recurring topics or questions that keep coming up",

  shouldEvaluate(buffer, config) {
    return buffer.messages.length >= config.ambient.triggers.patternCallout.minMessages;
  },

  async evaluate(ctx) {
    const conversationParts = formatBufferForLLMMultimodal(ctx.buffer.channelId, 40);

    const prompt: ContentPart[] = [
      { type: "text", text: `here's what's been going on in the channel:\n---\n` },
      ...conversationParts,
      { type: "text", text: `\n---\n\nhas the same thing come up multiple times? same question, same complaint, same person hitting the same wall?\n\nif there's a pattern, say something. examples:\n- "okay this is the third time someone's asked about the auth flow. we gotta fix that thing"\n- "funny how we had this exact conversation like two weeks ago and nothing changed"\n\nif no clear pattern, respond SKIP.` },
    ];

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: "checked for recurring patterns in 30+ messages",
    };
  },
};
