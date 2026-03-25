import type { AmbientTrigger } from "../types.js";
import { formatBufferForLLM } from "../buffer.js";

export const callbackTrigger: AmbientTrigger = {
  name: "callback",
  description: "References something from the past when it becomes relevant again",

  shouldEvaluate(buffer, config) {
    return buffer.messages.length >= config.ambient.triggers.callback.minMessages;
  },

  async evaluate(ctx) {
    const conversation = formatBufferForLLM(ctx.buffer.channelId, 15);

    // get unique users from the buffer to search memory
    const userIds = [...new Set(ctx.buffer.messages.map((m) => m.authorId))];
    const userNames = [...new Set(ctx.buffer.messages.map((m) => m.authorName))];

    const prompt = `here's what's being discussed:
---
${conversation}
---

the people talking are: ${userNames.join(", ")}

does anything connect to something from the past? a promise that aged badly, a prediction that came true, a complaint that's happening again? the more specific the better.

examples:
- "wait didn't someone say the exact opposite of this like two weeks ago"
- "oh so NOW we care about documentation lol"
- "this conversation is giving deja vu and not the good kind"

if you don't have a relevant callback, respond SKIP. don't force it.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: `checked callbacks for ${userNames.length} users`,
    };
  },
};
