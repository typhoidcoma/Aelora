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

    const prompt = `someone made a commitment and then went quiet.

${context}

react like a friend who noticed. examples:
- "wasn't someone supposed to 'handle it' like three hours ago lol"
- "love how that 'five minute fix' was four hours ago"
- "so that thing that was gonna be done by eod... it is no longer eod"

if the commitment seems too trivial, respond SKIP.`;

    const response = await ctx.llmEvaluate(prompt);
    return {
      message: response,
      debugReason: `${quietCommitters.length} user(s) went quiet after commitments`,
    };
  },
};
