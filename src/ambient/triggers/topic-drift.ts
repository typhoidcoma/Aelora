import type { AmbientTrigger } from "../types.js";

export const topicDriftTrigger: AmbientTrigger = {
  name: "topic-drift",
  description: "Notices when conversation has drifted wildly from where it started",

  shouldEvaluate(buffer, config) {
    const tc = config.ambient.triggers.topicDrift;
    if (buffer.messages.length < tc.minMessages) return false;
    const first = buffer.messages[0].timestamp;
    const last = buffer.messages[buffer.messages.length - 1].timestamp;
    return last - first >= tc.minSpanMinutes * 60 * 1000;
  },

  async evaluate(ctx) {
    const msgs = ctx.buffer.messages;
    const opening = msgs.slice(0, 5).map((m) => `${m.authorName}: ${m.content.slice(0, 200)}`).join("\n");
    const current = msgs.slice(-5).map((m) => `${m.authorName}: ${m.content.slice(0, 200)}`).join("\n");

    const prompt = `this conversation started with:
---
${opening}
---

and now it's about:
---
${current}
---

has the topic drifted absurdly far from where it started?

if the drift is funny, react to it. examples:
- "how did we get here from talking about the deploy lmao"
- "we started with a bug report and ended up debating pizza toppings and honestly that tracks"

if the drift isn't notable, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: "compared opening vs current conversation topics",
    };
  },
};
