import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { pruneFacts } from "./memory.js";
import { archiveOldSessions } from "./sessions.js";

// Run cleanup once per hour (track last run to skip most ticks)
let lastCleanup = 0;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const dataCleanup: HeartbeatHandler = {
  name: "data-cleanup",
  description: "Prunes old memory facts and archives stale sessions (hourly)",
  enabled: true,

  execute: async (ctx) => {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = now;

    const results: string[] = [];

    const memoryMaxAge = ctx.config.memory.maxAgeDays;
    if (memoryMaxAge > 0) {
      const pruned = pruneFacts(memoryMaxAge);
      if (pruned > 0) results.push(`pruned ${pruned} memory fact(s)`);
    }

    // Session archival: use same TTL as memory, or 30 days if memory TTL is off
    const sessionMaxAge = memoryMaxAge > 0 ? memoryMaxAge : 30;
    const archived = archiveOldSessions(sessionMaxAge);
    if (archived > 0) results.push(`archived ${archived} session(s)`);

    if (results.length > 0) return results.join(", ");
  },
};

export function registerDataCleanup(): void {
  registerHeartbeatHandler(dataCleanup);
}
