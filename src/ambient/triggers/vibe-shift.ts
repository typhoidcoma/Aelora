import type { AmbientTrigger } from "../types.js";

export const vibeShiftTrigger: AmbientTrigger = {
  name: "vibe-shift",
  description: "Detects when a channel's mood changes significantly",

  shouldEvaluate(buffer, config) {
    const tc = config.ambient.triggers.vibeShift;
    if (buffer.messages.length < tc.minMessages) return false;
    const first = buffer.messages[0].timestamp;
    const last = buffer.messages[buffer.messages.length - 1].timestamp;
    return last - first >= tc.minSpanMinutes * 60 * 1000;
  },

  async evaluate(ctx) {
    const msgs = ctx.buffer.messages;
    const midpoint = Math.floor(msgs.length / 2);

    const earlier = msgs.slice(0, midpoint).map((m) => `${m.authorName}: ${m.content}`).join("\n");
    const later = msgs.slice(midpoint).map((m) => `${m.authorName}: ${m.content}`).join("\n");

    const prompt = `this conversation started like this:

EARLIER:
---
${earlier}
---

and now it's like this:

LATER:
---
${later}
---

did the vibe shift? productive to chaotic, serious to unhinged, chill to stressed?

if the shift is real, react to it. examples:
- "oh we're just fully off the rails now huh"
- "how did we go from standup energy to this in fifteen minutes"

if no meaningful shift, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: "compared earlier vs later message tone",
    };
  },
};
