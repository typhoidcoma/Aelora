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

    const prompt = `here's what's been going on in the channel:
---
${conversation}
---

has the same thing come up multiple times? same question, same complaint, same person hitting the same wall?

if there's a pattern, say something. examples:
- "okay this is the third time someone's asked about the auth flow. we gotta fix that thing"
- "funny how we had this exact conversation like two weeks ago and nothing changed"

if no clear pattern, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: "checked for recurring patterns in 30+ messages",
    };
  },
};
