import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { syncKnowledgeBase, configureKnowledgeBase, type KnowledgeConfig } from "./knowledge-base.js";
import type { GoogleConfig } from "./tools/_google-auth.js";

let lastSync = 0;
let syncIntervalMs = 30 * 60 * 1000;

const knowledgeSync: HeartbeatHandler = {
  name: "knowledge-sync",
  description: "Syncs Google Drive knowledge base folder and indexes new/updated files",
  enabled: true,

  execute: async (_ctx) => {
    const now = Date.now();
    if (now - lastSync < syncIntervalMs) return;
    lastSync = now;

    const result = await syncKnowledgeBase();
    if (!result) return;

    const parts: string[] = [];
    if (result.added > 0) parts.push(`${result.added} added`);
    if (result.updated > 0) parts.push(`${result.updated} updated`);
    if (result.removed > 0) parts.push(`${result.removed} removed`);
    if (result.chunksIndexed > 0) parts.push(`${result.chunksIndexed} chunks indexed`);
    if (result.errors > 0) parts.push(`${result.errors} errors`);

    if (parts.length > 0) return `KB sync: ${parts.join(", ")}`;
  },
};

export function registerKnowledgeSync(cfg: KnowledgeConfig, gCfg: GoogleConfig): void {
  syncIntervalMs = cfg.syncIntervalMinutes * 60 * 1000;
  configureKnowledgeBase(cfg, gCfg);
  registerHeartbeatHandler(knowledgeSync);

  // Run first sync immediately in the background (don't block startup)
  lastSync = Date.now();
  syncKnowledgeBase()
    .then((result) => {
      if (!result) return;
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} added`);
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      if (result.chunksIndexed > 0) parts.push(`${result.chunksIndexed} chunks indexed`);
      if (result.errors > 0) parts.push(`${result.errors} errors`);
      if (parts.length > 0) console.log(`KnowledgeBase: initial sync complete — ${parts.join(", ")}`);
    })
    .catch((err) => console.warn("KnowledgeBase: initial sync failed:", err));
}
