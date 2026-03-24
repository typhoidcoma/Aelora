import type { AmbientTrigger } from "../types.js";

export const vibeShiftTrigger: AmbientTrigger = {
  name: "vibe-shift",
  description: "Detects when a channel's mood changes significantly",

  shouldEvaluate(buffer) {
    if (buffer.messages.length < 10) return false;
    // messages need to span at least 10 minutes
    const first = buffer.messages[0].timestamp;
    const last = buffer.messages[buffer.messages.length - 1].timestamp;
    return last - first >= 10 * 60 * 1000;
  },

  async evaluate(ctx) {
    const msgs = ctx.buffer.messages;
    const midpoint = Math.floor(msgs.length / 2);

    const earlier = msgs.slice(0, midpoint).map((m) => `${m.authorName}: ${m.content}`).join("\n");
    const later = msgs.slice(midpoint).map((m) => `${m.authorName}: ${m.content}`).join("\n");

    const prompt = `compare the tone of these two conversation segments from the same discord channel.

EARLIER:
---
${earlier}
---

LATER:
---
${later}
---

has the vibe shifted significantly? examples: chill to stressed, productive to chaotic, serious to unhinged, focused to completely off-topic, normal to weirdly wholesome.

if the shift is real and noticeable, write 1-2 sentences observing it. think "the vibe in here just did a complete 180" energy. all lowercase. don't address anyone.

if no meaningful shift, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: "compared earlier vs later message tone",
    };
  },
};
