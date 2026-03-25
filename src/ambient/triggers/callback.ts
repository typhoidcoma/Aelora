import type { AmbientTrigger, ContentPart } from "../types.js";
import { formatBufferForLLMMultimodal } from "../buffer.js";

export const callbackTrigger: AmbientTrigger = {
  name: "callback",
  description: "References something from the past when it becomes relevant again",

  shouldEvaluate(buffer, config) {
    return buffer.messages.length >= config.ambient.triggers.callback.minMessages;
  },

  async evaluate(ctx) {
    const conversationParts = formatBufferForLLMMultimodal(ctx.buffer.channelId, 15);

    // get unique users from the buffer to search memory
    const userNames = [...new Set(ctx.buffer.messages.map((m) => m.authorName))];

    const prompt: ContentPart[] = [
      { type: "text", text: `here's what's being discussed:\n---\n` },
      ...conversationParts,
      { type: "text", text: `\n---\n\nthe people talking are: ${userNames.join(", ")}\n\ndoes anything connect to something from the past? a promise that aged badly, a prediction that came true, a complaint that's happening again? the more specific the better.\n\nexamples:\n- "wait didn't someone say the exact opposite of this like two weeks ago"\n- "oh so NOW we care about documentation lol"\n- "this conversation is giving deja vu and not the good kind"\n\nif you don't have a relevant callback, respond SKIP. don't force it.` },
    ];

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: `checked callbacks for ${userNames.length} users`,
    };
  },
};
