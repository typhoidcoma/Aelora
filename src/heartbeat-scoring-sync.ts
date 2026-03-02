import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { getCachedSupabaseClient, ensureUserProfile, upsertLifeEvent } from "./supabase.js";
import { listTodos } from "./tools/todo.js";

// Sync every 5 minutes
let lastSync = 0;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

const scoringSync: HeartbeatHandler = {
  name: "scoring-sync",
  description: "Syncs Google Tasks into Supabase life_events for scoring (every 5 min)",
  enabled: true,

  execute: async (ctx) => {
    const now = Date.now();
    if (now - lastSync < SYNC_INTERVAL_MS) return;
    lastSync = now;

    const sb = getCachedSupabaseClient();
    if (!sb) return;

    const tools = ctx.config.tools as Record<string, Record<string, unknown>> | undefined;
    const g = tools?.["google"] as Record<string, string> | undefined;
    if (!g?.clientId || !g?.clientSecret || !g?.refreshToken) return;

    // Get all known user profiles to sync for
    const { data: profiles } = await sb.from("user_profiles").select("discord_user_id");
    if (!profiles || profiles.length === 0) return;

    const items = await listTodos(
      { clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: g.refreshToken },
      "@default",
      "pending",
    );
    if (items.length === 0) return;

    let synced = 0;
    for (const profile of profiles) {
      await ensureUserProfile(sb, profile.discord_user_id);
      for (const item of items) {
        await upsertLifeEvent(sb, {
          discord_user_id:   profile.discord_user_id,
          title:             item.title,
          description:       item.description ?? null,
          category:          "tasks",
          source:            "google_tasks",
          external_uid:      item.uid,
          priority:          item.priority,
          due_date:          item.dueDate ?? null,
          completed:         false,
          completed_at:      null,
          estimated_minutes: null,
          size_label:        null,
          impact_level:      null,
          irreversible:      null,
          affects_others:    null,
          smeq_estimate:     null,
          tags:              null,
        });
        synced++;
      }
    }

    return `synced ${items.length} task(s) for ${profiles.length} user(s)`;
  },
};

export function registerScoringSync(): void {
  registerHeartbeatHandler(scoringSync);
}
