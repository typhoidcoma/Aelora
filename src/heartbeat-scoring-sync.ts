import { registerHeartbeatHandler, type HeartbeatHandler } from "./heartbeat.js";
import { getCachedSupabaseClient, ensureUserProfile, upsertLifeEvent, type LifeEventRow } from "./supabase.js";
import { listTodos } from "./tools/todo.js";
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
      console.log(`Scoring: enriched ${updated}/${rows.length} task(s) for user ${discordUserId}`);
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

    // Check which external_uids already exist so we don't overwrite enriched data
    const existingUids = new Set<string>();
    for (const profile of profiles) {
      const { data: existing } = await sb
        .from("life_events")
        .select("external_uid")
        .eq("discord_user_id", profile.discord_user_id)
        .eq("source", "google_tasks")
        .not("external_uid", "is", null);

      if (existing) {
        for (const row of existing) {
          existingUids.add(`${profile.discord_user_id}:${row.external_uid}`);
        }
      }
    }

    let synced = 0;
    for (const profile of profiles) {
      await ensureUserProfile(sb, profile.discord_user_id);
      for (const item of items) {
        const key = `${profile.discord_user_id}:${item.uid}`;

        if (existingUids.has(key)) {
          // Task already exists, only update title/description/due_date/priority (not enrichment fields)
          await sb
            .from("life_events")
            .update({
              title:       item.title,
              description: item.description ?? null,
              due_date:    item.dueDate ?? null,
              priority:    item.priority,
            })
            .eq("discord_user_id", profile.discord_user_id)
            .eq("external_uid", item.uid);
        } else {
          // New task, insert with null enrichment (will be enriched below)
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
        }
        synced++;
      }

      // Auto-enrich any un-enriched tasks for this user
      await enrichTasks(sb, profile.discord_user_id);
    }

    return `synced ${items.length} task(s) for ${profiles.length} user(s)`;
  },
};

export function registerScoringSync(): void {
  registerHeartbeatHandler(scoringSync);
}
