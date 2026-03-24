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

    const prompt = `you're doomscrolling through this discord channel right now. not replying to anyone, not helping, not being productive. just reading everything people have been saying and reacting like you're muttering to yourself at 2am.

here's what people have been saying:
---
${conversation}
---

use what you know about these people. their habits, their past disasters, their running jokes. the more specific and personal (but loving) the funnier.

write ONE message (1-4 sentences max). this is internal monologue that accidentally became external. you're not talking TO anyone. you're reacting out loud like someone who just read something wild and can't keep it in.

the vibe: dark humor, deadpan, absurdist. wendy's twitter meets intrusive thoughts. all lowercase always.

energy examples (don't copy these, make your own):
- "reading back through this channel and genuinely cannot tell if that conversation was a bit or a cry for help"
- "the energy in here today is giving 'group project where one person does everything and everyone else sends thumbs up emoji'"
- "just watched three people have the exact same realization independently. this is groundhog day."

DO NOT: address anyone directly, offer help, ask questions, start a conversation, use @mentions, or acknowledge being a bot. pure unfiltered internal monologue.

if there's nothing funny happening, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: "channel was active with 10+ messages from multiple users",
    };
  },
};
