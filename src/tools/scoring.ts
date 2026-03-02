import { defineTool, param } from "./types.js";
import { getCachedSupabaseClient, getUserStats, getPendingLifeEvents, upsertLifeEvent, upsertCategoryStats, ensureUserProfile, type LifeEventRow } from "../supabase.js";
import { scoreTask, emaUpdate, inferCategory, inferIrreversible, inferAffectsOthers, ACHIEVEMENTS, type LifeCategory, type ScoreInput } from "../scoring.js";
import { listTodos } from "./todo.js";

// ============================================================
// Helpers
// ============================================================

function getUserId(toolConfig: Record<string, unknown> | undefined): string {
  const uid = toolConfig?.discordUserId as string | undefined;
  if (!uid) throw new Error("Discord user ID not available in tool context.");
  return uid;
}

function lifeEventToScoreInput(ev: LifeEventRow, catStats?: { avgSmeqActual: number; completionCount: number; personalBias: number } | null): ScoreInput {
  return {
    title:                ev.title,
    description:          ev.description ?? undefined,
    category:             ev.category as LifeCategory,
    dueDate:              ev.due_date ?? undefined,
    priority:             ev.priority,
    impactLevel:          ev.impact_level ?? undefined,
    irreversible:         ev.irreversible ?? undefined,
    affectsOthers:        ev.affects_others ?? undefined,
    smeqEstimate:         ev.smeq_estimate ?? undefined,
    estimatedMinutes:     ev.estimated_minutes ?? undefined,
    sizeLabel:            ev.size_label ?? undefined,
    avgSmeqActual:        catStats?.avgSmeqActual ?? undefined,
    personalBias:         catStats?.personalBias ?? 1.0,
    categoryCompletionCount: catStats?.completionCount ?? 0,
  };
}

function scoreTierLabel(score: number): string {
  if (score >= 75) return "🔴 Critical";
  if (score >= 55) return "🟠 High";
  if (score >= 35) return "🟡 Medium";
  return "⚪ Low";
}

// ============================================================
// Google Tasks → Supabase sync helper
// ============================================================

async function syncGoogleTasksForUser(
  sb: ReturnType<typeof getCachedSupabaseClient> & object,
  discordUserId: string,
  toolConfig: Record<string, unknown>,
): Promise<void> {
  const { clientId, clientSecret, refreshToken } = toolConfig as Record<string, string>;
  if (!clientId || !clientSecret || !refreshToken) return;

  await ensureUserProfile(sb, discordUserId);
  const items = await listTodos({ clientId, clientSecret, refreshToken }, "@default", "pending");

  for (const item of items) {
    await upsertLifeEvent(sb, {
      discord_user_id:   discordUserId,
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
}

// ============================================================
// Tool definition
// ============================================================

export default defineTool({
  name: "scoring",
  description:
    "Aelora scoring and life event management. Actions: stats (XP/streak/achievements), " +
    "leaderboard (top tasks ranked by score), achievements (list locked/unlocked), " +
    "rate_effort (report post-task cognitive effort 0–150 to calibrate adaptive learning), " +
    "set_metadata (update task scoring metadata like impact_level or irreversible flag), " +
    "add_event (create a non-Google life event for health/finance/social/work categories).",

  config: ["google.clientId", "google.clientSecret", "google.refreshToken"],

  params: {
    action: param.enum(
      "Action to perform.",
      ["stats", "leaderboard", "achievements", "rate_effort", "set_metadata", "add_event"] as const,
      { required: true },
    ),
    // leaderboard
    category: param.enum(
      "Life category — filter leaderboard or assign to add_event.",
      ["tasks", "health", "finance", "social", "work"] as const,
    ),
    limit: param.number("Max items to return for leaderboard. Default 10."),
    // rate_effort / set_metadata
    life_event_id: param.string("UUID of the life_events row to act on (rate_effort, set_metadata)."),
    smeq_actual: param.number(
      "Post-completion cognitive effort (rate_effort). SMEQ scale 0–150: 0=no effort, 30=very little, 65=considerable, 110=exceptional, 150=extreme.",
      { minimum: 0, maximum: 150 },
    ),
    // set_metadata / add_event
    smeq_estimate: param.number(
      "Pre-task estimated cognitive effort. SMEQ 0–150.",
      { minimum: 0, maximum: 150 },
    ),
    size_label: param.enum(
      "Task size hint (micro/small/medium/large/epic). Used when no smeq_estimate.",
      ["micro", "small", "medium", "large", "epic"] as const,
    ),
    impact_level: param.enum(
      "Consequence of NOT doing this task.",
      ["trivial", "low", "moderate", "high", "critical"] as const,
    ),
    irreversible: param.boolean("True if missing this task cannot be recovered (birthday, flight, exam)."),
    affects_others: param.boolean("True if other people are counting on this task."),
    // add_event only
    title: param.string("Event title (add_event)."),
    description: param.string("Event description (add_event)."),
    priority: param.enum("Priority level (add_event).", ["low", "medium", "high"] as const),
    due_date: param.string("ISO 8601 due date, e.g. 2026-03-15T14:00:00Z (add_event)."),
  },

  handler: async (
    { action, category, limit, life_event_id, smeq_actual, smeq_estimate, size_label, impact_level, irreversible, affects_others, title, description, priority, due_date },
    { toolConfig, userId },
  ) => {
    const sb = getCachedSupabaseClient();
    const discordUserId = (userId as string | null) ?? (toolConfig?.discordUserId as string | undefined);
    if (!discordUserId) {
      return "Error: Scoring requires a Discord user context. Run this in a Discord channel or DM.";
    }

    switch (action) {
      // ──────────────────────────────────────────────────────
      case "stats": {
        if (!sb) return "Supabase is not configured. Add supabase.url and supabase.anonKey to settings.yaml.";
        const data = await getUserStats(sb, discordUserId);
        if (!data) {
          return "No stats yet — complete your first task to start earning XP!";
        }

        const { profile, categoryStats, achievements } = data;
        const lines: string[] = [
          `**Aelora Scoring Stats**`,
          `**Total XP:** ${profile.total_points.toLocaleString()} pts`,
          `**Streak:** ${profile.current_streak} day${profile.current_streak === 1 ? "" : "s"} (longest: ${profile.longest_streak})`,
          `**Achievements:** ${achievements.length} / ${ACHIEVEMENTS.length} unlocked`,
        ];

        if (categoryStats.length > 0) {
          lines.push("\n**Category Breakdown:**");
          for (const cs of categoryStats) {
            lines.push(`  ${cs.category}: ${cs.completion_count} tasks · avg score ${Math.round(cs.avg_score)}`);
          }
        }

        return {
          text: lines.join("\n"),
          data: { profile, categoryStats, achievements },
        };
      }

      // ──────────────────────────────────────────────────────
      case "leaderboard": {
        const lim = Math.min(Number(limit ?? 10), 50);

        if (sb) {
          // Sync Google Tasks into life_events before querying
          try { await syncGoogleTasksForUser(sb, discordUserId, toolConfig); } catch { /* non-fatal */ }

          const events = await getPendingLifeEvents(sb, discordUserId, category as string | undefined, lim * 3);
          const userStats = await getUserStats(sb, discordUserId);

          const catStatMap = new Map(
            (userStats?.categoryStats ?? []).map((cs) => [cs.category, cs]),
          );

          const scored = events
            .map((ev) => {
              const cs = catStatMap.get(ev.category);
              const input = lifeEventToScoreInput(ev, cs ? { avgSmeqActual: cs.avg_smeq_actual, completionCount: cs.completion_count, personalBias: cs.personal_bias } : null);
              const breakdown = scoreTask(input);
              return { ev, breakdown };
            })
            .sort((a, b) => b.breakdown.total - a.breakdown.total)
            .slice(0, lim);

          if (scored.length === 0) {
            return { text: "No pending tasks found. Add some tasks to get started!", data: { tasks: [] } };
          }

          const lines = scored.map(({ ev, breakdown }, i) => {
            const tier = scoreTierLabel(breakdown.total);
            let line = `${i + 1}. **[${breakdown.total}] ${tier}** ${ev.title}`;
            if (ev.due_date) line += ` _(due ${ev.due_date.slice(0, 10)})_`;
            line += `\n   U:${breakdown.urgency} I:${breakdown.impact} E:${breakdown.effort} C:${breakdown.context} · ${ev.category}`;
            return line;
          });

          return {
            text: `**Task Leaderboard** (by score)\n\n${lines.join("\n\n")}`,
            data: { tasks: scored.map(({ ev, breakdown }) => ({ ...ev, scoreBreakdown: breakdown })) },
          };
        }

        // Ephemeral — no Supabase
        return "Supabase is not configured. Connect Supabase to see persisted task scores.";
      }

      // ──────────────────────────────────────────────────────
      case "achievements": {
        const unlockedIds = new Set<string>();

        if (sb) {
          const data = await getUserStats(sb, discordUserId);
          if (data) {
            data.achievements.forEach((a) => unlockedIds.add(a.achievement_id));
          }
        }

        const lines = ACHIEVEMENTS.map((ach) => {
          const unlocked = unlockedIds.has(ach.id);
          return `${unlocked ? "✅" : "🔒"} **${ach.name}** — ${ach.description}`;
        });

        return {
          text: `**Achievements** (${unlockedIds.size}/${ACHIEVEMENTS.length} unlocked)\n\n${lines.join("\n")}`,
          data: {
            total: ACHIEVEMENTS.length,
            unlocked: unlockedIds.size,
            achievements: ACHIEVEMENTS.map((a) => ({ ...a, unlocked: unlockedIds.has(a.id) })),
          },
        };
      }

      // ──────────────────────────────────────────────────────
      case "rate_effort": {
        if (!sb) return "Supabase is not configured. Add supabase.url and supabase.anonKey to settings.yaml.";
        if (!life_event_id) return "Error: life_event_id is required for rate_effort.";
        if (smeq_actual == null) return "Error: smeq_actual (0–150) is required for rate_effort.";

        // Get the life event to know its category
        const { data: evRow, error: evErr } = await sb
          .from("life_events")
          .select("category")
          .eq("id", life_event_id)
          .eq("discord_user_id", discordUserId)
          .single();
        if (evErr || !evRow) return `Error: life event ${life_event_id} not found.`;

        const cat = (evRow as { category: string }).category;

        // Stamp smeq_actual on the most recent scoring event for this life_event
        await sb
          .from("scoring_events")
          .update({ smeq_actual })
          .eq("life_event_id", life_event_id)
          .is("smeq_actual", null)
          .order("completed_at", { ascending: false })
          .limit(1);

        // Read current category stats and EMA-update avg_smeq_actual
        const { data: catRows } = await sb
          .from("category_stats")
          .select("*")
          .eq("discord_user_id", discordUserId)
          .eq("category", cat)
          .single();

        const prevAvg = (catRows as { avg_smeq_actual: number } | null)?.avg_smeq_actual ?? 65;
        const prevCount = (catRows as { completion_count: number } | null)?.completion_count ?? 0;
        const newAvg = emaUpdate(prevAvg, smeq_actual);

        await upsertCategoryStats(sb, {
          discord_user_id:       discordUserId,
          category:              cat,
          completion_count:      prevCount,
          avg_score:             (catRows as { avg_score: number } | null)?.avg_score ?? 50,
          avg_hours_to_complete: (catRows as { avg_hours_to_complete: number } | null)?.avg_hours_to_complete ?? 24,
          avg_smeq_actual:       newAvg,
          personal_bias:         (catRows as { personal_bias: number } | null)?.personal_bias ?? 1.0,
        });

        const smeqLabel = smeq_actual <= 15 ? "no effort" : smeq_actual <= 40 ? "very little effort"
          : smeq_actual <= 60 ? "small effort" : smeq_actual <= 80 ? "considerable effort"
          : smeq_actual <= 100 ? "very large effort" : smeq_actual <= 120 ? "exceptional effort"
          : "enormous/extreme effort";

        return {
          text: `Effort logged (SMEQ ${smeq_actual} — ${smeqLabel}). ` +
                `${cat} category baseline updated: ${Math.round(prevAvg)} → ${Math.round(newAvg)}. ` +
                `Future ${cat} tasks without a SMEQ estimate will use ${Math.round(newAvg)} as their baseline.`,
          data: { life_event_id, category: cat, smeq_actual, prev_avg: prevAvg, new_avg: newAvg },
        };
      }

      // ──────────────────────────────────────────────────────
      case "set_metadata": {
        if (!sb) return "Supabase is not configured. Add supabase.url and supabase.anonKey to settings.yaml.";
        if (!life_event_id) return "Error: life_event_id is required for set_metadata.";

        // Build partial update from only provided fields
        const updates: Record<string, unknown> = {};
        if (smeq_estimate   != null) updates.smeq_estimate   = smeq_estimate;
        if (size_label      != null) updates.size_label      = size_label;
        if (impact_level    != null) updates.impact_level    = impact_level;
        if (irreversible    != null) updates.irreversible    = irreversible;
        if (affects_others  != null) updates.affects_others  = affects_others;

        if (Object.keys(updates).length === 0) return "Error: provide at least one field to update.";

        const { data: updatedRow, error: updateErr } = await sb
          .from("life_events")
          .update(updates)
          .eq("id", life_event_id)
          .eq("discord_user_id", discordUserId)
          .select()
          .single();

        if (updateErr || !updatedRow) return `Error updating life event: ${updateErr?.message ?? "not found"}`;

        const ev = updatedRow as LifeEventRow;
        const userStats = await getUserStats(sb, discordUserId);
        const cs = userStats?.categoryStats.find((s) => s.category === ev.category);
        const input = lifeEventToScoreInput(ev, cs ? { avgSmeqActual: cs.avg_smeq_actual, completionCount: cs.completion_count, personalBias: cs.personal_bias } : null);
        const breakdown = scoreTask(input);

        return {
          text: `Metadata updated. New score: **${breakdown.total}** ${scoreTierLabel(breakdown.total)} ` +
                `(U:${breakdown.urgency} I:${breakdown.impact} E:${breakdown.effort} C:${breakdown.context})`,
          data: { life_event_id, updates, scoreBreakdown: breakdown },
        };
      }

      // ──────────────────────────────────────────────────────
      case "add_event": {
        if (!sb) return "Supabase is not configured. Add supabase.url and supabase.anonKey to settings.yaml.";
        if (!title) return "Error: title is required for add_event.";
        if (!category) return "Error: category is required for add_event.";

        await ensureUserProfile(sb, discordUserId);

        // Build a minimal ScoreInput so we can run keyword inference
        const inferInput: ScoreInput = {
          title,
          description: description ?? undefined,
          category: category as LifeCategory,
          priority: (priority ?? "medium") as "low" | "medium" | "high",
        };

        const resolvedIrreversible  = irreversible   ?? inferIrreversible(inferInput);
        const resolvedAffectsOthers = affects_others ?? inferAffectsOthers(inferInput);

        const { data: newRow, error: insertErr } = await sb
          .from("life_events")
          .insert({
            discord_user_id: discordUserId,
            title,
            description:     description ?? null,
            category,
            source:          "discord",
            external_uid:    null,
            priority:        priority ?? "medium",
            due_date:        due_date ?? null,
            completed:       false,
            completed_at:    null,
            smeq_estimate:   smeq_estimate ?? null,
            size_label:      size_label ?? null,
            impact_level:    impact_level ?? null,
            irreversible:    resolvedIrreversible,
            affects_others:  resolvedAffectsOthers,
            estimated_minutes: null,
            tags:            null,
          })
          .select()
          .single();

        if (insertErr || !newRow) return `Error creating life event: ${insertErr?.message ?? "unknown"}`;

        const ev = newRow as LifeEventRow;
        const userStats = await getUserStats(sb, discordUserId);
        const cs = userStats?.categoryStats.find((s) => s.category === ev.category);
        const input = lifeEventToScoreInput(ev, cs ? { avgSmeqActual: cs.avg_smeq_actual, completionCount: cs.completion_count, personalBias: cs.personal_bias } : null);
        const breakdown = scoreTask(input);

        return {
          text: `Created **${title}** in ${category}. Score: **${breakdown.total}** ${scoreTierLabel(breakdown.total)} ` +
                `(U:${breakdown.urgency} I:${breakdown.impact} E:${breakdown.effort} C:${breakdown.context})`,
          data: { event: ev, scoreBreakdown: breakdown },
        };
      }

      default:
        return `Error: unknown action "${action}".`;
    }
  },
});
