import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { updateLastAlive } from "./state.js";

const aliveHandler: HeartbeatHandler = {
  name: "last-alive",
  description: "Updates the last-alive timestamp for force-kill detection",
  enabled: true,

  execute: async () => {
    updateLastAlive();
    // Silent — no return value so heartbeat won't log every tick
  },
};

export function registerLastAlive(): void {
  registerHeartbeatHandler(aliveHandler);
}
