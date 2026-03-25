import type { AmbientTrigger } from "../types.js";
import { formatBufferForLLM, getRecentMessages } from "../buffer.js";

export const lurkerTrigger: AmbientTrigger = {
  name: "lurker",
  description: "Drops a muttered self-talk observation when a channel is active and entertaining",

  shouldEvaluate(buffer, config) {
    const tc = config.ambient.triggers.lurker;
    const windowMs = tc.windowMinutes * 60 * 1000;
    const recent = getRecentMessages(buffer.channelId, windowMs);
    if (recent.length < tc.minMessages) return false;
    const uniqueUsers = new Set(recent.map((m) => m.authorId));
    return uniqueUsers.size >= tc.minUsers;
  },

  async evaluate(ctx) {
    const conversation = formatBufferForLLM(ctx.buffer.channelId, 25);

    const prompt = `here's what people have been saying in the channel:
---
${conversation}
---

use what you know about these people. react to whatever's funniest, weirdest, or most unhinged like you're part of the group chat.

examples (don't copy these, make your own):
- "wait did three people just independently discover the same thing lmao"
- "genuinely can't tell if that was a bit or a cry for help"
- "okay the group project energy rn is immaculate though"

if nothing's interesting, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: "channel was active with 10+ messages from multiple users",
    };
  },
};
