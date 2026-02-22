import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { compactPendingHistory } from "./llm.js";

const memoryCompaction: HeartbeatHandler = {
  name: "memory-compaction",
  description: "Compacts trimmed conversation history into summaries (threshold-based, most ticks are no-ops)",
  enabled: true,

  execute: async () => {
    await compactPendingHistory(10);
  },
};

export function registerMemoryCompaction(): void {
  registerHeartbeatHandler(memoryCompaction);
}
