import type { AmbientTrigger } from "../types.js";
import { getAllSessions } from "../../sessions.js";

const QUIET_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours of silence

export const deadChannelTrigger: AmbientTrigger = {
  name: "dead-channel",
  description: "Pokes a normally active channel that has gone quiet",

  shouldEvaluate(buffer) {
    if (buffer.messages.length === 0) return false;

    const lastMsg = buffer.messages[buffer.messages.length - 1];
    const silenceMs = Date.now() - lastMsg.timestamp;

    if (silenceMs < QUIET_THRESHOLD_MS) return false;

    // check if this channel is normally active (via sessions)
    const sessions = getAllSessions();
    const session = sessions.find((s) => s.channelId === buffer.channelId);
    if (!session) return false;

    // only poke if the channel has a decent message history
    return session.messageCount >= 20;
  },

  async evaluate(ctx) {
    const lastMsg = ctx.buffer.messages[ctx.buffer.messages.length - 1];
    const silenceHours = Math.round((Date.now() - lastMsg.timestamp) / (60 * 60 * 1000));
    const lastFew = ctx.buffer.messages.slice(-5).map(
      (m) => `${m.authorName}: ${m.content.slice(0, 200)}`,
    ).join("\n");

    const prompt = `this discord channel has been quiet for about ${silenceHours} hour(s). it's usually active. the last messages were:
---
${lastFew}
---

write 1-2 sentences acknowledging the silence. not trying to start a conversation. not asking a question. just... observing the emptiness. like you're in an abandoned building.

all lowercase. channel-poke energy, not "hey guys what's up" energy.

examples:
- "it's quiet in here. too quiet."
- "this channel went from 100 to 0 real fast. everyone just collectively decided to have a life at the same time huh"
- "the last message in here was ${silenceHours} hours ago and it was about [topic]. what a way to end an era."

if this channel being quiet seems normal (late night, weekend, etc), respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      delayMs: 1000 + Math.random() * 3000,
      debugReason: `channel quiet for ${silenceHours}h`,
    };
  },
};
