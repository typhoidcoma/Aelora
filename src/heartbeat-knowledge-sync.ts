import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { syncKnowledgeBase, configureKnowledgeBase, type KnowledgeConfig } from "./knowledge-base.js";
import type { GoogleConfig } from "./tools/_google-auth.js";

let lastFullSync = 0;
let syncIntervalMs = 30 * 60 * 1000;
let syncing = false;
let hasPendingWork = false;

const knowledgeSync: HeartbeatHandler = {
  name: "knowledge-sync",
  description: "Syncs Google Drive knowledge base folder and indexes new/updated files",
  enabled: true,

  execute: async (_ctx) => {
    if (syncing) return;

    // If last run finished cleanly, respect the full sync interval. If work
    // was left over (remaining > 0), run again on the next tick to drain.
    const now = Date.now();
    if (!hasPendingWork && now - lastFullSync < syncIntervalMs) return;

    syncing = true;
    try {
      const result = await syncKnowledgeBase();
      if (!result) return;

      hasPendingWork = result.remaining > 0;
      if (!hasPendingWork) lastFullSync = now;

      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} added`);
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      if (result.removed > 0) parts.push(`${result.removed} removed`);
      if (result.chunksIndexed > 0) parts.push(`${result.chunksIndexed} chunks indexed`);
      if (result.errors > 0) parts.push(`${result.errors} errors`);
      if (result.remaining > 0) parts.push(`${result.remaining} pending`);

      if (parts.length > 0) return `KB sync: ${parts.join(", ")}`;
    } finally {
      syncing = false;
    }
  },
};

export function registerKnowledgeSync(cfg: KnowledgeConfig, gCfg: GoogleConfig): void {
  syncIntervalMs = cfg.syncIntervalMinutes * 60 * 1000;
  configureKnowledgeBase(cfg, gCfg);
  registerHeartbeatHandler(knowledgeSync);

  // Run first sync immediately in the background (don't block startup).
  // Guard against double-run if a heartbeat tick fires before this finishes.
  syncing = true;
  syncKnowledgeBase()
    .then((result) => {
      if (!result) return;
      hasPendingWork = result.remaining > 0;
      if (!hasPendingWork) lastFullSync = Date.now();
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} added`);
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      if (result.chunksIndexed > 0) parts.push(`${result.chunksIndexed} chunks indexed`);
      if (result.errors > 0) parts.push(`${result.errors} errors`);
      if (result.remaining > 0) parts.push(`${result.remaining} pending`);
      if (parts.length > 0) console.log(`KnowledgeBase: initial sync complete — ${parts.join(", ")}`);
    })
    .catch((err) => console.warn("KnowledgeBase: initial sync failed:", err))
    .finally(() => {
      syncing = false;
    });
}
