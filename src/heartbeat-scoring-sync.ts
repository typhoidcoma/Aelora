import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { getCachedSupabaseClient, ensureUserProfile, upsertLifeEvent } from "./supabase.js";
import { listEvents } from "./tools/google-calendar.js";
import { extractUserTag } from "./tools/calendar.js";
import { extractGoogleConfig } from "./tools/_google-auth.js";
import { getLLMClient, getAuxiliaryModel, stripThinkBlocks } from "./llm.js";
import type OpenAI from "openai";

// Sync every 5 minutes
let lastSync = 0;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

// ── LLM enrichment prompt ──────────────────────────────────

const ENRICH_SYSTEM =
  "You are a JSON-only task analyzer. Output ONLY a JSON array. No text before or after. No explanation. No markdown.\n\n" +
  "For each task provided, infer scoring metadata from the title and description.\n\n" +
  "Output format (one object per task, same order as input):\n" +
  '[{"impact_level":"trivial|low|moderate|high|critical","size_label":"micro|small|medium|large|epic",' +
  '"estimated_minutes":number,"irreversible":boolean,"affects_others":boolean,' +
  '"category":"tasks|health|finance|social|work"}]\n\n' +
  "Guidelines:\n" +
  "- impact_level: how significant is missing/completing this task?\n" +
  "- size_label: how much work is involved?\n" +
  "- estimated_minutes: realistic time estimate\n" +
  "- irreversible: would failing to do this cause permanent consequences?\n" +
  "- affects_others: does this impact other people?\n" +
  "- category: best fit from the 5 options";

type EnrichResult = {
  impact_level?: string;
  size_label?: string;
  estimated_minutes?: number;
  irreversible?: boolean;
  affects_others?: boolean;
  category?: string;
};

const VALID_IMPACT = ["trivial", "low", "moderate", "high", "critical"];
const VALID_SIZE = ["micro", "small", "medium", "large", "epic"];
const VALID_CATEGORY = ["tasks", "health", "finance", "social", "work"];

// ── Enrichment logic ──────────────────────────────────────

async function enrichTasks(
  sb: ReturnType<typeof getCachedSupabaseClient>,
  discordUserId: string,
): Promise<number> {
  if (!sb) return 0;

  // Find un-enriched tasks (impact_level is null = never enriched)
  const { data: rows } = await sb
    .from("life_events")
    .select("id, title, description")
    .eq("discord_user_id", discordUserId)
    .eq("completed", false)
    .is("impact_level", null)
    .limit(20);

  if (!rows || rows.length === 0) return 0;

  const client = getLLMClient();
  const model = getAuxiliaryModel();

  const taskList = rows
    .map((r, i) => `${i + 1}. ${r.title}${r.description ? ` - ${r.description}` : ""}`)
    .join("\n");

  try {
    const params: Record<string, unknown> = {
      model,
      max_completion_tokens: 4096,
      messages: [
        { role: "system", content: ENRICH_SYSTEM },
        { role: "user", content: taskList },
      ],
    };

    const result = await client.chat.completions.create(
      params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    );

    let rawContent = stripThinkBlocks(result.choices[0]?.message?.content?.trim() ?? "");
    if (!rawContent) return 0;

    // Strip code fences
    rawContent = rawContent.replace(/^```(?:json)?\s*\n?/gm, "").replace(/\n?```\s*$/gm, "").trim();

    // Extract JSON array
    const arrStart = rawContent.indexOf("[");
    const arrEnd = rawContent.lastIndexOf("]");
    if (arrStart === -1 || arrEnd === -1) {
      console.warn("Scoring enrichment: no JSON array found:", rawContent.slice(0, 100));
      return 0;
    }

    let enriched: EnrichResult[];
    try {
      enriched = JSON.parse(rawContent.slice(arrStart, arrEnd + 1));
    } catch {
      console.warn("Scoring enrichment: failed to parse JSON:", rawContent.slice(arrStart, arrStart + 100));
      return 0;
    }

    if (!Array.isArray(enriched)) return 0;

    let updated = 0;
    for (let i = 0; i < Math.min(rows.length, enriched.length); i++) {
      const e = enriched[i];
      if (!e || typeof e !== "object") continue;

      const updates: Record<string, unknown> = {};

      if (e.impact_level && VALID_IMPACT.includes(e.impact_level)) {
        updates.impact_level = e.impact_level;
      }
      if (e.size_label && VALID_SIZE.includes(e.size_label)) {
        updates.size_label = e.size_label;
      }
      if (typeof e.estimated_minutes === "number" && e.estimated_minutes > 0) {
        updates.estimated_minutes = Math.round(e.estimated_minutes);
      }
      if (typeof e.irreversible === "boolean") {
        updates.irreversible = e.irreversible;
      }
      if (typeof e.affects_others === "boolean") {
        updates.affects_others = e.affects_others;
      }
      if (e.category && VALID_CATEGORY.includes(e.category)) {
        updates.category = e.category;
      }

      // Only update if we got at least impact_level (minimum useful enrichment)
      if (updates.impact_level) {
        const { error } = await sb
          .from("life_events")
          .update(updates)
          .eq("id", rows[i].id);

        if (!error) updated++;
      }
    }

    if (updated > 0) {
      console.log(`Scoring: enriched ${updated}/${rows.length} item(s) for user ${discordUserId}`);
    }
    return updated;
  } catch (err) {
    console.warn("Scoring enrichment failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

// ── Heartbeat handler ──────────────────────────────────────

const scoringSync: HeartbeatHandler = {
  name: "scoring-sync",
  description: "Syncs calendar events into Supabase life_events for scoring (every 5 min)",
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

    const googleConfig = { clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: g.refreshToken };

    let totalSynced = 0;
    const usersWithActivity = new Set<string>();

    // ── Sync calendar events from primary calendar ──────────
    try {
      const events = await listEvents(googleConfig, "primary", { maxResults: 100, daysAhead: 30 });

      // Group events by user via the [user:ID] tag in description
      const eventsByUser = new Map<string, typeof events>();

      for (const event of events) {
        const { userId } = extractUserTag(event.description);
        if (!userId) continue; // Skip untagged events

        if (!eventsByUser.has(userId)) eventsByUser.set(userId, []);
        eventsByUser.get(userId)!.push(event);
      }

      for (const [discordUserId, userEvents] of eventsByUser) {
        await ensureUserProfile(sb, discordUserId);

        const { data: existing } = await sb
          .from("life_events")
          .select("external_uid")
          .eq("discord_user_id", discordUserId)
          .eq("source", "google_calendar")
          .not("external_uid", "is", null);

        const existingUids = new Set(
          (existing ?? []).map((r) => (r as { external_uid: string }).external_uid),
        );

        for (const event of userEvents) {
          const startStr = event.start.dateTime ?? event.start.date ?? null;
          const dueDate = startStr ? startStr.slice(0, 10) : null;

          let estimatedMinutes: number | null = null;
          if (event.start.dateTime && event.end.dateTime) {
            const dur = (new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime()) / 60_000;
            if (dur > 0 && dur < 1440) estimatedMinutes = Math.round(dur);
          }

          // Strip user tag from description before storing
          const cleanDesc = event.description?.replace(/\n?\[user:\d+(?::[^\]]+)?\]/, "").trim() || null;

          if (existingUids.has(event.id)) {
            await sb
              .from("life_events")
              .update({
                title:             event.summary ?? "Untitled event",
                description:       cleanDesc,
                due_date:          dueDate,
                estimated_minutes: estimatedMinutes,
              })
              .eq("discord_user_id", discordUserId)
              .eq("external_uid", event.id);
          } else {
            await upsertLifeEvent(sb, {
              discord_user_id:   discordUserId,
              title:             event.summary ?? "Untitled event",
              description:       cleanDesc,
              category:          "tasks",
              source:            "google_calendar",
              external_uid:      event.id,
              priority:          "medium",
              due_date:          dueDate,
              completed:         false,
              completed_at:      null,
              estimated_minutes: estimatedMinutes,
              size_label:        null,
              impact_level:      null,
              irreversible:      null,
              affects_others:    null,
              smeq_estimate:     null,
              tags:              null,
            });
          }
          totalSynced++;
        }

        usersWithActivity.add(discordUserId);
      }
    } catch (err) {
      console.warn("Scoring sync: calendar failed:", err instanceof Error ? err.message : err);
    }

    // Auto-enrich un-enriched items for all active users
    for (const uid of usersWithActivity) {
      await enrichTasks(sb, uid);
    }

    if (totalSynced > 0) {
      return `synced ${totalSynced} event(s) for ${usersWithActivity.size} user(s)`;
    }
  },
};

export function registerScoringSync(): void {
  registerHeartbeatHandler(scoringSync);
}
