import type { AmbientTrigger } from "../types.js";
import { formatBufferForLLM } from "../buffer.js";

export const callbackTrigger: AmbientTrigger = {
  name: "callback",
  description: "References something from the past when it becomes relevant again",

  shouldEvaluate(buffer) {
    // always worth checking if there's enough conversation
    return buffer.messages.length >= 8;
  },

  async evaluate(ctx) {
    const conversation = formatBufferForLLM(ctx.buffer.channelId, 15);

    // get unique users from the buffer to search memory
    const userIds = [...new Set(ctx.buffer.messages.map((m) => m.authorId))];
    const userNames = [...new Set(ctx.buffer.messages.map((m) => m.authorName))];

    const prompt = `you're reading this discord conversation:
---
${conversation}
---

the people talking are: ${userNames.join(", ")}

think about what you know about these people from memory. their past conversations, things they've said, promises they made, habits, running jokes, old incidents, things they complained about before.

is there a natural, funny callback to something from the past? something like:
- "didn't someone say the exact opposite of this like two weeks ago"
- "oh so NOW we care about documentation. interesting."
- "this conversation is giving major deja vu and not in a good way"

write 1-2 sentences making the callback. it should feel like "oh that reminds me" but snarky. the more specific the memory, the funnier it hits.

all lowercase. don't address anyone directly. don't offer help.

if you don't have any relevant memories or callbacks, respond SKIP. don't force it.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: `checked callbacks for ${userNames.length} users`,
    };
  },
};
