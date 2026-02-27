import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { compactPendingHistory } from "./llm.js";

const memoryCompaction: HeartbeatHandler = {
  name: "memory-compaction",
  description: "Compacts trimmed conversation history into summaries (threshold-based, most ticks are no-ops)",
  enabled: true,

  execute: async () => {
    const count = await compactPendingHistory();
    if (count > 0) return `compacted ${count} conversation(s)`;
  },
};

export function registerMemoryCompaction(): void {
  registerHeartbeatHandler(memoryCompaction);
}
