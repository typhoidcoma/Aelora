import type { AmbientTrigger } from "../types.js";

export const topicDriftTrigger: AmbientTrigger = {
  name: "topic-drift",
  description: "Notices when conversation has drifted wildly from where it started",

  shouldEvaluate(buffer) {
    if (buffer.messages.length < 20) return false;
    // messages need to span at least 15 minutes
    const first = buffer.messages[0].timestamp;
    const last = buffer.messages[buffer.messages.length - 1].timestamp;
    return last - first >= 15 * 60 * 1000;
  },

  async evaluate(ctx) {
    const msgs = ctx.buffer.messages;
    const opening = msgs.slice(0, 5).map((m) => `${m.authorName}: ${m.content.slice(0, 200)}`).join("\n");
    const current = msgs.slice(-5).map((m) => `${m.authorName}: ${m.content.slice(0, 200)}`).join("\n");

    const prompt = `this discord conversation started with:
---
${opening}
---

and is now about:
---
${current}
---

has the topic drifted wildly and amusingly far from where it started? like starting with a bug report and ending up debating pizza toppings. the more absurd the drift, the better.

if the drift is notable and funny, write 1-2 sentences observing it. think "we started talking about X and somehow ended up at Y and honestly i respect the journey" energy.

all lowercase. don't address anyone. don't try to get the conversation back on track.

if the drift isn't notable or amusing, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: "compared opening vs current conversation topics",
    };
  },
};
