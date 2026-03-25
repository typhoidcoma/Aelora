import type { AmbientTrigger } from "../types.js";
import { getAllSessions } from "../../sessions.js";

export const deadChannelTrigger: AmbientTrigger = {
  name: "dead-channel",
  description: "Pokes a normally active channel that has gone quiet",

  shouldEvaluate(buffer, config) {
    if (buffer.messages.length === 0) return false;

    const tc = config.ambient.triggers.deadChannel;
    const lastMsg = buffer.messages[buffer.messages.length - 1];
    const silenceMs = Date.now() - lastMsg.timestamp;

    if (silenceMs < tc.silenceMinutes * 60 * 1000) return false;

    const sessions = getAllSessions();
    const session = sessions.find((s) => s.channelId === buffer.channelId);
    if (!session) return false;

    return session.messageCount >= tc.minSessionMessages;
  },

  async evaluate(ctx) {
    const lastMsg = ctx.buffer.messages[ctx.buffer.messages.length - 1];
    const silenceHours = Math.round((Date.now() - lastMsg.timestamp) / (60 * 60 * 1000));
    const lastFew = ctx.buffer.messages.slice(-5).map(
      (m) => `${m.authorName}: ${m.content.slice(0, 200)}`,
    ).join("\n");

    const prompt = `this channel has been quiet for about ${silenceHours} hour(s). it's usually active. the last messages were:
---
${lastFew}
---

react like someone who's also in the quiet channel. examples:
- "did everyone just collectively decide to have a life at the same time"
- "okay so we're just not talking today huh"
- "this channel went from 100 to 0 real fast"

if the silence seems normal (late night, weekend), respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      delayMs: 1000 + Math.random() * 3000,
      debugReason: `channel quiet for ${silenceHours}h`,
    };
  },
};
