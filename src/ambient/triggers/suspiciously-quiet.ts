import type { AmbientTrigger } from "../types.js";

const COMMITMENT_PATTERNS = /\b(i'll|i will|gonna|going to|let me|brb|will do|on it|give me a sec|working on|about to|promise)\b/i;

export const suspiciouslyQuietTrigger: AmbientTrigger = {
  name: "suspiciously-quiet",
  description: "Notices when someone promised something and then went silent",

  shouldEvaluate(buffer, config) {
    const tc = config.ambient.triggers.suspiciouslyQuiet;
    if (buffer.messages.length < tc.minMessages) return false;

    const now = Date.now();
    const silenceMs = tc.silenceMinutes * 60 * 1000;
    const activeUsers = new Map<string, { lastMsg: number; lastContent: string; name: string }>();

    for (const msg of buffer.messages) {
      activeUsers.set(msg.authorId, {
        lastMsg: msg.timestamp,
        lastContent: msg.content,
        name: msg.authorName,
      });
    }

    for (const [, user] of activeUsers) {
      if (now - user.lastMsg >= silenceMs && COMMITMENT_PATTERNS.test(user.lastContent)) {
        return true;
      }
    }
    return false;
  },

  async evaluate(ctx) {
    const now = Date.now();
    const tc = ctx.config.ambient.triggers.suspiciouslyQuiet;
    const silenceMs = tc.silenceMinutes * 60 * 1000;
    const quietCommitters: Array<{ name: string; said: string; silentFor: number }> = [];

    const activeUsers = new Map<string, { lastMsg: number; lastContent: string; name: string }>();
    for (const msg of ctx.buffer.messages) {
      activeUsers.set(msg.authorId, {
        lastMsg: msg.timestamp,
        lastContent: msg.content,
        name: msg.authorName,
      });
    }

    for (const [, user] of activeUsers) {
      const silentMsActual = now - user.lastMsg;
      if (silentMsActual >= silenceMs && COMMITMENT_PATTERNS.test(user.lastContent)) {
        quietCommitters.push({
          name: user.name,
          said: user.lastContent.slice(0, 200),
          silentFor: Math.round(silentMsActual / (60 * 60 * 1000)),
        });
      }
    }

    if (quietCommitters.length === 0) {
      return { message: null, debugReason: "no quiet committers found on re-check" };
    }

    const context = quietCommitters
      .map((q) => `- ${q.name} said "${q.said}" and has been silent for ~${q.silentFor} hour(s)`)
      .join("\n");

    const prompt = `someone in this discord channel made a commitment and then went radio silent.

${context}

write 1-2 sentences noticing the silence. not accusatory, not helpful. just... noticing. like you're narrating a true crime documentary about productivity.

all lowercase. don't @ anyone. don't offer help. just ominously observe the silence.

examples of the vibe:
- "someone said they'd 'handle it' and then vanished into the void. the silence is telling."
- "it's been real quiet since someone promised a fix by end of day. it is no longer end of day."

if the commitment seems too trivial to comment on, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: `${quietCommitters.length} user(s) went quiet after commitments`,
    };
  },
};
