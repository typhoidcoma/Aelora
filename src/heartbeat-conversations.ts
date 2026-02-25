import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { saveConversations } from "./llm.js";

// Save every 5 minutes (skip most heartbeat ticks which default to 60s)
let lastSave = 0;
const SAVE_INTERVAL_MS = 5 * 60 * 1000;

const conversationSave: HeartbeatHandler = {
  name: "conversation-save",
  description: "Periodically saves conversation history to disk",
  enabled: true,

  execute: async () => {
    const now = Date.now();
    if (now - lastSave < SAVE_INTERVAL_MS) return;
    lastSave = now;

    saveConversations();
    return "saved conversations";
  },
};

export function registerConversationSave(): void {
  registerHeartbeatHandler(conversationSave);
}
