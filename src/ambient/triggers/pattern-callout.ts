import type { AmbientTrigger } from "../types.js";
import { formatBufferForLLM } from "../buffer.js";

export const patternCalloutTrigger: AmbientTrigger = {
  name: "pattern-callout",
  description: "Notices recurring topics or questions that keep coming up",

  shouldEvaluate(buffer, config) {
    return buffer.messages.length >= config.ambient.triggers.patternCallout.minMessages;
  },

  async evaluate(ctx) {
    const conversation = formatBufferForLLM(ctx.buffer.channelId, 40);

    const prompt = `look at this conversation history from a discord channel:
---
${conversation}
---

has the same topic, question, complaint, or situation come up multiple times? maybe different people asking the same thing. maybe the same person hitting the same wall. maybe a pattern nobody's noticed yet.

if you spot a clear pattern, point it out naturally in 1-3 sentences. think "this is the third time someone's asked about X this week" energy. observational, amused, slightly ominous.

all lowercase. don't address anyone. don't offer solutions. just point out the pattern like you're a detective connecting dots on a whiteboard.

if no clear pattern, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: "checked for recurring patterns in 30+ messages",
    };
  },
};
